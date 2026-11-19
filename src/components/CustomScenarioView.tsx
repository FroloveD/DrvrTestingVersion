/**
 * @module components/CustomScenarioView
 * @layer ui
 * @role Редактор карт и сценариев: офлайн-импорт OSM (.osm XML / Overpass JSON / GeoJSON), палитра знаков и объектов, 2D drag-and-drop, инспектор и Undo/Redo.
 * @invariants #1 (координаты и курс h), #8–#9 (офлайн-импорт + атрибуция ODbL 1.0), #15 (снимок мира в попытке), #16 (без неподписанных штрафов).
 * @tests T16, T27–T32; смоук A, G, O, P (`tests/browser-smoke.mjs`)
 *
 * Оглавление секций (`grep -n "SEC:custom-"`):
 * - `[SEC:custom-fields]`  — числовые/текстовые поля ввода и справочники редактора (`NumField`, `TextField`).
 * - `[SEC:custom-preview]` — палитра классов, сетка/слои, Undo/Redo и интерактивный 2D-холст (`MapCanvasEditor`).
 * - `[SEC:custom-forms]`   — инспектор выбранного объекта, реестр объектов, параметры карты и памятка импорта OSM.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOUNDARY_SHAPE_PRESETS, polygonArea, type BoundaryShapePreset } from "../maps/boundary";
import { cropOsmPackToPolygon, type NormalizedOsmPack } from "../maps/osmLoader";
import { listRouteCandidates } from "../maps/route";
import { checkScenarioRoute, type RouteCheckTarget } from "../maps/routeCheck";
import {
  buildCityOsmScenario,
  buildParallelScenario,
  buildPerpendicularScenario,
} from "../scenarios/catalog";
import {
  customFromOsmPack,
  customFromWorld,
  defaultCustomScenario,
  emptyCustomScenario,
  importEditorFileText,
  validateCustomScenario,
  type CustomScenarioDef,
} from "../scenarios/custom";
import {
  appendRoadPoint,
  applyConvexHullBoundary,
  applyPresetBoundaryShape,
  applyRouteCorridorBoundary,
  attachCheckpointToSign,
  autoFixScenarioRoute,
  bringSelectionToFront,
  clearBoundaryPolygon,
  createEditorHistory,
  cropScenarioToBoundary,
  deconflictScenarioWithRoads,
  deleteSelected,
  duplicateSelected,
  fitBoundsToContent,
  getSelectionAnchor,
  insertBoundaryPoint,
  mergeUserObjectsOntoOsmMap,
  moveSelected,
  primarySelection,
  pushEditorHistory,
  rebuildRouteFromEditorRoads,
  redoEditorHistory,
  reverseRoadDirection,
  rotateSelected,
  setCustomBoundaryPolygon,
  setSelectedHeading,
  undoEditorHistory,
  type EditorSelection,
  type EditorTool,
} from "../scenarios/editorOps";
import {
  formatSignBadge,
  getObstacleSpec,
  getRoadSignSpec,
  isSpeedSignKind,
  OBSTACLE_CATALOG,
  ROAD_SIGN_CATALOG,
} from "../scenarios/signs";
import type {
  CalibrationConfig,
  ObstacleKind,
  ParkedModelKey,
  ParkingBayKind,
  RoadSignKind,
  Vec2,
} from "../sim/types";
import { INTERNET_RADIO_STATIONS } from "../audio/radioCatalog";
import { DEFAULT_PLAYER_CAR_ID, PLAYER_CARS, getPlayerCar } from "../sim/playerCar";
import { VEHICLE_DIMS } from "../sim/vehicle";
import { Chip, downloadJson, Icon } from "./Icons";
import { DEFAULT_LAYERS, MapCanvasEditor, type LayerVisibility } from "./MapCanvasEditor";

type Props = {
  def: CustomScenarioDef;
  onChange: (next: CustomScenarioDef) => void;
  rawOsmPack: NormalizedOsmPack | null;
  onRawOsmPackChange: (pack: NormalizedOsmPack | null) => void;
  autoOpenRouteCheck?: boolean;
  onConsumeAutoOpenRouteCheck?: () => void;
  calibration: CalibrationConfig;
  onOpenInSimulator: () => void;
  onNotify: (msg: string) => void;
};

type ListFilter = "all" | "signs" | "signals" | "crosswalks" | "roads" | "bays" | "obstacles" | "checkpoints";

const radToDeg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 10) / 10;
const degToRad = (deg: number) => (deg * Math.PI) / 180;
const hexFromNum = (c: number | undefined, fallback: number): string =>
  `#${((c ?? fallback) & 0xffffff).toString(16).padStart(6, "0")}`;
const numFromHex = (hex: string): number => Number.parseInt(hex.replace("#", ""), 16) || 0x94a3b8;

// === [SEC:custom-fields] Вспомогательные поля ввода и справочники редактора ===
function NumField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  const safeVal = Number.isFinite(value) ? value : 0;
  const [text, setText] = useState<string>(() => String(safeVal));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(safeVal));
    }
  }, [safeVal]);

  const clampNum = (n: number): number => {
    let v = n;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    return v;
  };

  const commitText = (raw: string) => {
    const normalized = raw.trim().replace(",", ".");
    if (!normalized || normalized === "-" || normalized === "." || normalized === "-.") {
      setText(String(safeVal));
      return;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      setText(String(safeVal));
      return;
    }
    const clamped = clampNum(parsed);
    setText(String(clamped));
    if (clamped !== safeVal) onChange(clamped);
  };

  return (
    <label className="block min-w-0">
      <span className="mono text-[10px] text-[#7c909d] block mb-1">{label}</span>
      <input
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          // Промежуточный ввод («-», пустая строка, «12.») не сбрасываем до потери фокуса
          const norm = raw.trim().replace(",", ".");
          if (!norm || norm === "-" || norm.endsWith(".")) return;
          const n = Number(norm);
          if (!Number.isFinite(n)) return;
          if ((min === undefined || n >= min) && (max === undefined || n <= max) && n !== safeVal) {
            onChange(n);
          }
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          commitText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitText((e.target as HTMLInputElement).value);
          }
        }}
        className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 mono text-xs text-white"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mono text-[10px] text-[#7c909d] block mb-1">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
      />
    </label>
  );
}

const TOOL_BUTTONS: Array<{ id: EditorTool; label: string; badge: string }> = [
  { id: "select", label: "Выбор / Перенос", badge: "↖" },
  { id: "pan", label: "Панорама", badge: "✥" },
  { id: "boundary", label: "Форма площадки", badge: "⬠" },
  { id: "sign", label: "Дорожный знак", badge: "⊘" },
  { id: "signal", label: "Светофор", badge: "🚦" },
  { id: "crosswalk", label: "Переход", badge: "≡" },
  { id: "road", label: "Дорога", badge: "═" },
  { id: "bay", label: "Бокс парковки", badge: "P" },
  { id: "obstacle", label: "Препятствие", badge: "■" },
  { id: "checkpoint", label: "Точка КТ", badge: "◎" },
  { id: "start", label: "Старт авто", badge: "▲" },
];

const BAY_KINDS: Array<{ v: ParkingBayKind; l: string }> = [
  { v: "perpendicular", l: "Перпендикулярный 90°" },
  { v: "parallel", l: "Параллельный карман" },
];

const HIGHWAY_TYPES: Array<{ v: string; l: string }> = [
  { v: "residential", l: "Жилая улица (residential)" },
  { v: "secondary", l: "Городская (secondary)" },
  { v: "primary", l: "Магистральная (primary)" },
  { v: "tertiary", l: "Районная (tertiary)" },
  { v: "living_street", l: "Жилая зона (living_street)" },
  { v: "service", l: "Проезд / площадка (service)" },
];

const PARKED_MODELS: ParkedModelKey[] = ["picanto", "rio", "ceed", "xceed", "sorento"];
const SPEED_PRESETS = [20, 30, 40, 50, 60, 70, 90] as const;
const SNAP_OPTIONS: Array<{ v: number; l: string; hint: string }> = [
  { v: 0, l: "Выкл", hint: "Скрыть сетку и отключить привязку — свободное перемещение объектов (0,1 м / 1°)" },
  { v: 0.5, l: "0,5 м", hint: "Мелкая сетка и привязка 0,5 м — точная расстановка конусов, стоек и дорожных знаков" },
  { v: 1, l: "1 м", hint: "Сетка и привязка 1 м — ровное выравнивание парковочных боксов, бордюров и стоп-линий" },
  { v: 2, l: "2 м", hint: "Сетка и привязка 2 м — разметка полос, переходов и углов площадки" },
  { v: 5, l: "5 м", hint: "Крупная сетка и привязка 5 м — улицы, здания и произвольный контур мира" },
];

const LAYER_LABELS: Array<{ k: keyof LayerVisibility; l: string }> = [
  { k: "boundary", l: "Граница" },
  { k: "roads", l: "Дороги" },
  { k: "bays", l: "Боксы" },
  { k: "obstacles", l: "Препятствия" },
  { k: "signs", l: "Знаки" },
  { k: "zones", l: "Зоны км/ч" },
  { k: "signals", l: "Светофоры" },
  { k: "crosswalks", l: "Переходы" },
  { k: "checkpoints", l: "КТ" },
];

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function CustomScenarioView({
  def,
  onChange,
  rawOsmPack,
  onRawOsmPackChange,
  autoOpenRouteCheck,
  onConsumeAutoOpenRouteCheck,
  calibration,
  onOpenInSimulator,
  onNotify,
}: Props) {
  const importRef = useRef<HTMLInputElement | null>(null);
  const [tool, setTool] = useState<EditorTool>("select");
  const [selection, setSelection] = useState<EditorSelection | null>({ kind: "start" });
  const [snapStep, setSnapStep] = useState<number>(0.5);
  const [preserveOnImport, setPreserveOnImport] = useState<boolean>(false);
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const [fitSignal, setFitSignal] = useState<number>(0);
  const [focusSignal, setFocusSignal] = useState<number>(0);

  // Произвольная граница (рисование многоугольника от руки и ширина коридора маршрута)
  const [draftBoundary, setDraftBoundary] = useState<Vec2[]>([]);
  const [corridorBufferM, setCorridorBufferM] = useState<number>(28);

  // Интерактивная проверка и настройка маршрута OSM / редактора
  const [showRouteCheck, setShowRouteCheck] = useState<boolean>(() => Boolean(def.mapMeta));
  const [routeCandidateId, setRouteCandidateId] = useState<string>("");
  const [routeReverse, setRouteReverse] = useState<boolean>(false);

  // Параметры добавляемого объекта в палитре
  const [signKind, setSignKind] = useState<RoadSignKind>("speed_limit");
  const [signSpeedLimit, setSignSpeedLimit] = useState<number>(40);
  const [obstacleKind, setObstacleKind] = useState<ObstacleKind>("cone");
  const [parkedModel, setParkedModel] = useState<ParkedModelKey>("rio");
  const [bayKind, setBayKind] = useState<ParkingBayKind>("perpendicular");
  const [placeHeadingDeg, setPlaceHeadingDeg] = useState<number>(0);

  // История отмен и фильтр реестра объектов
  const [history, setHistory] = useState(() => createEditorHistory<CustomScenarioDef>());
  const [listFilter, setListFilter] = useState<ListFilter>("all");
  const [showOsmHelp, setShowOsmHelp] = useState(false);

  // Сворачивание (−) и закрытие (×) панелей интерфейса 2D-редактора
  const [editorCollapsed, setEditorCollapsed] = useState<Record<string, boolean>>({});
  const [editorClosed, setEditorClosed] = useState<Record<string, boolean>>({});
  const toggleEditorCollapse = (key: string) =>
    setEditorCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const closeEditorCard = (key: string) =>
    setEditorClosed((prev) => ({ ...prev, [key]: true }));
  const reopenEditorCard = (key: string) => {
    setEditorClosed((prev) => ({ ...prev, [key]: false }));
    setEditorCollapsed((prev) => ({ ...prev, [key]: false }));
  };
  const anySidebarOpen = !editorClosed.inspector || !editorClosed.objects || !editorClosed.bounds;

  const validation = useMemo(() => validateCustomScenario(def), [def]);
  const routeCheck = useMemo(() => checkScenarioRoute(def), [def]);
  const routeCandidates = useMemo(
    () => listRouteCandidates(def.roads ?? [], def.boundaryPolygon),
    [def.roads, def.boundaryPolygon]
  );
  const blocked = validation.errors.length > 0;

  useEffect(() => {
    if (autoOpenRouteCheck) {
      setShowRouteCheck(true);
      setFitSignal((n) => n + 1);
      onConsumeAutoOpenRouteCheck?.();
    }
  }, [autoOpenRouteCheck, onConsumeAutoOpenRouteCheck]);

  const commitChange = useCallback(
    (next: CustomScenarioDef, before: CustomScenarioDef = def) => {
      if (next === before) return;
      setHistory((h) => pushEditorHistory(h, before));
      onChange(next);
    },
    [def, onChange]
  );

  /** Отмеченные в сценарии станции; пустое/отсутствующее поле означает весь каталог. */
  const radioList = useMemo(() => {
    const saved = def.radioStationIds ?? [];
    const known = saved.filter((id) => INTERNET_RADIO_STATIONS.some((st) => st.id === id));
    return known.length > 0 ? known : INTERNET_RADIO_STATIONS.map((st) => st.id);
  }, [def.radioStationIds]);

  const patchDef = useCallback(
    (patch: Partial<CustomScenarioDef>) => {
      commitChange({ ...def, ...patch }, def);
    },
    [commitChange, def]
  );

  const handleUndo = useCallback(() => {
    const res = undoEditorHistory(history, def);
    if (!res) return;
    setHistory(res.history);
    onChange(res.state);
    onNotify("Действие отменено (Ctrl+Z)");
  }, [def, history, onChange, onNotify]);

  const handleRedo = useCallback(() => {
    const res = redoEditorHistory(history, def);
    if (!res) return;
    setHistory(res.history);
    onChange(res.state);
    onNotify("Действие возвращено (Ctrl+Y)");
  }, [def, history, onChange, onNotify]);

  const handleDuplicate = useCallback(() => {
    if (!selection) return;
    const dup = duplicateSelected(def, selection);
    if (!dup) {
      onNotify("Стартовая позиция единственная — перетащите её на нужное место");
      return;
    }
    commitChange(dup.def, def);
    setSelection(dup.selection);
    onNotify("Объект продублирован");
  }, [commitChange, def, onNotify, selection]);

  const handleDelete = useCallback(() => {
    if (!selection || selection.kind === "start") return;
    const res = deleteSelected(def, selection);
    commitChange(res.def, def);
    setSelection(res.selection);
    onNotify("Объект удалён");
  }, [commitChange, def, onNotify, selection]);

  const handleQuickRotate = useCallback(
    (deltaDeg: number) => {
      if (!selection) return;
      const next = rotateSelected(def, selection, degToRad(deltaDeg));
      commitChange(next, def);
    },
    [commitChange, def, selection]
  );

  // Завершение рисования произвольного полигона границы (опционально — сразу с обрезкой дорог/зданий)
  const handleFinishBoundary = useCallback(
    (pts: Vec2[], alsoCrop: boolean) => {
      const res = setCustomBoundaryPolygon(def, pts);
      if (!res.ok) {
        onNotify(res.error ?? "Не удалось применить контур границы");
        return;
      }
      let next = res.def;
      if (alsoCrop) {
        const cropped = cropScenarioToBoundary(next);
        next = cropped.def;
        commitChange(next, def);
        setDraftBoundary([]);
        setTool("select");
        setSelection({ kind: "start" });
        setFitSignal((n) => n + 1);
        setShowRouteCheck(true);
        onNotify(
          `Контур применён (${next.boundaryPolygon?.length ?? 0} т.) и карта обрезана: убрано дорог ${cropped.removedRoads}, объектов ${cropped.removedObjects}, КТ ${cropped.keptCheckpoints}`
        );
        return;
      }
      commitChange(next, def);
      setDraftBoundary([]);
      setTool("select");
      setSelection({ kind: "boundary_point", index: 0 });
      setFitSignal((n) => n + 1);
      onNotify(
        `Задана произвольная граница (${next.boundaryPolygon?.length ?? 0} вершин). Нажмите «Обрезать по границе», чтобы убрать внешние улицы.`
      );
    },
    [commitChange, def, onNotify]
  );

  const handleCancelBoundary = useCallback(() => {
    if (draftBoundary.length > 0) {
      setDraftBoundary([]);
      onNotify("Черновик контура очищен");
    } else {
      setTool("select");
    }
  }, [draftBoundary.length, onNotify]);

  // Горячие клавиши редактора (не перехватываются при вводе текста в поля)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (tool === "boundary" && draftBoundary.length > 0) {
        if (e.code === "Enter" && draftBoundary.length >= 3) {
          e.preventDefault();
          handleFinishBoundary(draftBoundary, false);
          return;
        }
        if (e.code === "Backspace") {
          e.preventDefault();
          setDraftBoundary((prev) => prev.slice(0, -1));
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          setDraftBoundary([]);
          return;
        }
      }
      if (mod && e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((mod && e.code === "KeyY") || (mod && e.shiftKey && e.code === "KeyZ")) {
        e.preventDefault();
        handleRedo();
      } else if (mod && e.code === "KeyD") {
        e.preventDefault();
        handleDuplicate();
      } else if (e.code === "KeyR" && !mod && selection) {
        e.preventDefault();
        handleQuickRotate(e.shiftKey ? 15 : -15);
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (selection && selection.kind !== "start") {
          e.preventDefault();
          handleDelete();
        }
      } else if (e.code === "Escape") {
        setDraftBoundary([]);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    draftBoundary,
    handleDelete,
    handleDuplicate,
    handleFinishBoundary,
    handleQuickRotate,
    handleRedo,
    handleUndo,
    selection,
    tool,
  ]);

  const applyImportedScenario = (
    next: CustomScenarioDef,
    message: string,
    opts?: { rawPack?: NormalizedOsmPack | null; openCheck?: boolean }
  ) => {
    commitChange(next, def);
    setDraftBoundary([]);
    setRouteCandidateId("");
    setRouteReverse(false);
    if (opts?.rawPack !== undefined) onRawOsmPackChange(opts.rawPack);
    if (opts?.openCheck !== undefined) setShowRouteCheck(opts.openCheck);
    setSelection({ kind: "start" });
    setTool("select");
    setFitSignal((n) => n + 1);
    onNotify(message);
  };

  const readAndImportFile = async (file: File) => {
    if (file.size > 30 * 1024 * 1024) {
      onNotify("Файл больше 30 МБ — выберите меньший участок карты OSM");
      return;
    }
    try {
      const text = await file.text();
      const { def: imported, kind, summary, rawPack } = importEditorFileText(text, file.name);
      const isOsmMap = kind === "osm_xml" || kind === "osm_json" || kind === "geojson";
      if (isOsmMap && preserveOnImport) {
        const merged = mergeUserObjectsOntoOsmMap(def, imported);
        const keptObjects = merged.keptBays + merged.keptSigns;
        const mergeNote =
          keptObjects > 0 || merged.keptCheckpoints > 0
            ? ` · перенесено объектов: ${keptObjects}, КТ: ${merged.keptCheckpoints}${merged.reprojected ? " (WGS84)" : ""}`
            : "";
        applyImportedScenario(merged.def, `${summary}${mergeNote}`, {
          rawPack: rawPack ?? null,
          openCheck: true,
        });
        return;
      }
      applyImportedScenario(imported, summary, {
        rawPack: rawPack ?? null,
        openCheck: isOsmMap || imported.checkpoints.length > 0,
      });
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось импортировать файл карты");
    }
  };

  const handleImportInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await readAndImportFile(file);
  };

  const handleAutoRoute = (customCandId = routeCandidateId, reverse = routeReverse) => {
    const res = rebuildRouteFromEditorRoads(def, {
      candidateId: customCandId || undefined,
      reverse,
    });
    if (res.count === 0) {
      onNotify("Внутри текущей границы не найдено дороги длиной ≥ 12 м для построения маршрута");
      return;
    }
    commitChange(res.def, def);
    setSelection({ kind: "start" });
    setShowRouteCheck(true);
    if (res.reverseBlocked) {
      setRouteReverse(false);
      onNotify(
        `«${res.roadName ?? "Улица"}» — односторонняя по данным OSM: маршрут построен по разрешённому направлению (${res.count} КТ)`
      );
      return;
    }
    onNotify(
      `Построен маршрут (${res.count} КТ, ${Math.round(res.lengthM)} м)${res.roadName ? ` по «${res.roadName}»` : ""}${reverse ? " · реверс" : ""}`
    );
  };

  const handleDeconflictWithRoads = () => {
    const res = deconflictScenarioWithRoads(def);
    if (res.changedCount === 0) {
      onNotify("Конфликтов с дорожной сетью не обнаружено: здания, знаки, стойки и маршрут согласованы");
      return;
    }
    commitChange(res.def, def);
    setShowRouteCheck(true);
    onNotify(`Согласовано с дорогами (${res.changedCount}): ${res.fixes[0] ?? "коллизии устранены"}`);
  };

  const handleAutoFixRoute = () => {
    const { def: fixed, fixes } = autoFixScenarioRoute(def);
    if (fixes.length === 0) {
      onNotify("Проверка пройдена: автоматические исправления не требуются");
      return;
    }
    commitChange(fixed, def);
    setShowRouteCheck(true);
    setFitSignal((n) => n + 1);
    onNotify(`Исправлено (${fixes.length}): ${fixes[0]}`);
  };

  const handleCorridorBoundary = (alsoCrop = false) => {
    const res = applyRouteCorridorBoundary(def, corridorBufferM);
    if (!res.ok) {
      onNotify("Нужна хотя бы одна дорога или 2 контрольные точки для коридора маршрута");
      return;
    }
    let next = res.def;
    if (alsoCrop) {
      const cropped = cropScenarioToBoundary(next);
      next = cropped.def;
      commitChange(next, def);
      setDraftBoundary([]);
      setFitSignal((n) => n + 1);
      setShowRouteCheck(true);
      onNotify(
        `Коридор маршрута ±${corridorBufferM} м (${res.vertices} т.) применён с обрезкой: убрано дорог ${cropped.removedRoads}, объектов ${cropped.removedObjects}`
      );
      return;
    }
    commitChange(next, def);
    setDraftBoundary([]);
    setFitSignal((n) => n + 1);
    onNotify(
      `Построен коридор маршрута ±${corridorBufferM} м (${res.vertices} вершин). Вершины можно двигать или обрезать карту.`
    );
  };

  const handleHullBoundary = () => {
    const res = applyConvexHullBoundary(def, 14);
    if (!res.ok) {
      onNotify("Недостаточно объектов для построения оболочки");
      return;
    }
    commitChange(res.def, def);
    setDraftBoundary([]);
    setFitSignal((n) => n + 1);
    onNotify(`Построена многоугольная оболочка площадки (${res.vertices} вершин)`);
  };

  const handlePresetBoundary = (preset: BoundaryShapePreset) => {
    const meta = BOUNDARY_SHAPE_PRESETS.find((p) => p.id === preset);
    const res = applyPresetBoundaryShape(def, preset);
    commitChange(res.def, def);
    setDraftBoundary([]);
    setTool("boundary");
    setSelection({ kind: "boundary_point", index: 0 });
    setFitSignal((n) => n + 1);
    onNotify(
      `Форма площадки: «${meta?.label ?? preset}» (${res.vertices} вершин). Тяните янтарные углы или кликайте бирюзовые точки на сторонах.`
    );
  };

  const handleBringSelectedToFront = () => {
    const res = bringSelectionToFront(def, selection);
    if (!res.moved) {
      onNotify("Объект уже находится на переднем слое");
      return;
    }
    commitChange(res.def, def);
    onNotify("Объект помещён на передний план");
  };

  const handleCropToBoundary = () => {
    // Если есть исходная выгрузка OSM и задан полигон, можно также обрезать текущую сцену с сохранением ручных правок
    const cropped = cropScenarioToBoundary(def);
    commitChange(cropped.def, def);
    setSelection({ kind: "start" });
    setFitSignal((n) => n + 1);
    setShowRouteCheck(true);
    onNotify(
      `Карта обрезана по границе: убрано дорог ${cropped.removedRoads}, объектов ${cropped.removedObjects}, КТ в маршруте: ${cropped.keptCheckpoints}`
    );
  };

  const handleRecropFromRawOsm = () => {
    if (!rawOsmPack) return;
    if (def.boundaryPolygon && def.boundaryPolygon.length >= 3) {
      const recropped = cropOsmPackToPolygon(rawOsmPack, def.boundaryPolygon);
      const next = customFromOsmPack(recropped, def.title);
      commitChange(next, def);
      setFitSignal((n) => n + 1);
      setShowRouteCheck(true);
      onNotify(
        `Пересобрано из полной выгрузки OSM по новому контуру: дорог ${next.roads?.length ?? 0}, КТ ${next.checkpoints.length}`
      );
    } else {
      const restored = customFromOsmPack(rawOsmPack, def.title);
      commitChange(restored, def);
      setFitSignal((n) => n + 1);
      setShowRouteCheck(true);
      onNotify(`Восстановлена полная выгрузка OSM (${restored.roads?.length ?? 0} дорог)`);
    }
  };

  const handleRestoreFullOsm = () => {
    if (!rawOsmPack) return;
    const restored = customFromOsmPack(rawOsmPack);
    commitChange(restored, def);
    setDraftBoundary([]);
    setSelection({ kind: "start" });
    setFitSignal((n) => n + 1);
    setShowRouteCheck(true);
    onNotify(`Восстановлена вся выгрузка OSM до обрезки (дорог: ${restored.roads?.length ?? 0})`);
  };

  const handleResetBoundaryToRect = () => {
    const fitted = clearBoundaryPolygon(def, 12);
    commitChange(fitted, def);
    setDraftBoundary([]);
    if (selection?.kind === "boundary_point") setSelection({ kind: "start" });
    setFitSignal((n) => n + 1);
    const sx = Math.round(fitted.bounds.maxX - fitted.bounds.minX);
    const sz = Math.round(fitted.bounds.maxZ - fitted.bounds.minZ);
    onNotify(`Граница сброшена в пропорциональный прямоугольник ${sx}×${sz} м`);
  };

  const handleFitBounds = () => {
    const fitted = fitBoundsToContent(def, 12);
    commitChange(fitted, def);
    setFitSignal((n) => n + 1);
    const sx = Math.round(fitted.bounds.maxX - fitted.bounds.minX);
    const sz = Math.round(fitted.bounds.maxZ - fitted.bounds.minZ);
    onNotify(`Границы карты подогнаны по содержимому (${sx}×${sz} м)`);
  };

  const focusIssueTarget = (target?: RouteCheckTarget) => {
    if (!target) return;
    if (target.kind === "boundary") {
      setTool("boundary");
      if (def.boundaryPolygon && def.boundaryPolygon.length > 0) {
        setSelection({ kind: "boundary_point", index: 0 });
        setFocusSignal((n) => n + 1);
      }
      return;
    }
    setTool("select");
    setSelection(target);
    setFocusSignal((n) => n + 1);
  };

  const roads = def.roads ?? [];
  const signs = def.signs ?? [];
  const signals = def.signals ?? [];
  const crosswalks = def.crosswalks ?? [];

  const primary = primarySelection(selection);
  const selectedAnchor = getSelectionAnchor(def, selection);

  const selectedSign = primary?.kind === "sign" ? signs.find((s) => s.id === primary.id) ?? null : null;
  const selectedSignal = primary?.kind === "signal" ? signals.find((s) => s.id === primary.id) ?? null : null;
  const selectedCrosswalk = primary?.kind === "crosswalk" ? crosswalks.find((c) => c.id === primary.id) ?? null : null;
  const selectedRoad = primary?.kind === "road" ? roads.find((r) => r.id === primary.id) ?? null : null;
  const selectedBay = primary?.kind === "bay" ? def.bays.find((b) => b.id === primary.id) ?? null : null;
  const selectedObstacle = primary?.kind === "obstacle" ? def.obstacles.find((o) => o.id === primary.id) ?? null : null;
  const selectedCp = primary?.kind === "checkpoint" ? def.checkpoints.find((c) => c.id === primary.id) ?? null : null;

  const totalObjects =
    roads.length +
    signs.length +
    signals.length +
    crosswalks.length +
    def.bays.length +
    def.obstacles.length +
    def.checkpoints.length;

  const placeOptions = useMemo(
    () => ({
      signKind,
      signSpeedLimit,
      obstacleKind,
      parkedModel,
      bayKind,
      calibration,
      headingRad: degToRad(placeHeadingDeg),
      snapStep,
    }),
    [bayKind, calibration, obstacleKind, parkedModel, placeHeadingDeg, signKind, signSpeedLimit, snapStep]
  );

  return (
    <div className="space-y-4">
      {/* Шапка редактора карт и кнопка офлайн-импорта */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Редактор карт · Офлайн</Chip>
            <Chip tone={blocked ? "red" : "mint"}>
              {blocked ? `Ошибок: ${validation.errors.length}` : "Готов к заезду"}
            </Chip>
            {validation.warnings.length > 0 && (
              <Chip tone="amber">Подсказок: {validation.warnings.length}</Chip>
            )}
            {def.mapMeta && <Chip tone="neutral">OSM · ODbL 1.0</Chip>}
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Свой сценарий и редактор карт</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1 max-w-[78ch]">
            Конструктор упражнений и городских участков: импортируйте локальные файлы OSM (`.osm` XML, Overpass JSON,
            GeoJSON), расставляйте и перетаскивайте дорожные знаки, светофоры, переходы, дороги, боксы и препятствия.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={importRef}
            data-testid="editor-import-input"
            type="file"
            accept=".osm,.xml,.json,.geojson,application/json,application/xml,text/xml"
            className="hidden"
            onChange={handleImportInput}
          />
          <button
            type="button"
            className="btn btn-mini"
            title="Загрузить локальный .osm (XML), Overpass .json, .geojson, сценарий или бэкап (до 30 МБ, без сети)"
            onClick={() => importRef.current?.click()}
          >
            <Icon name="upload" size={13} /> Импорт OSM / GeoJSON / JSON
          </button>
          <label
            className="inline-flex items-center gap-1.5 rounded-lg border hairline bg-[#0b131a] px-2 py-1 text-[11px] text-[#c5d4de] cursor-pointer select-none"
            title="При повторном импорте карты OSM / GeoJSON перенести ваши боксы, ручные знаки и маршрут (с точным пересчётом координат WGS84 и очисткой проезжей части)"
          >
            <input
              type="checkbox"
              data-testid="editor-import-preserve-toggle"
              checked={preserveOnImport}
              onChange={(e) => setPreserveOnImport(e.target.checked)}
              className="accent-[#52d6bd]"
            />
            <span>Сохранить мои объекты</span>
          </label>
            <button
              type="button"
              data-testid="editor-route-check-btn"
              className="btn btn-mini"
              onClick={() => setShowRouteCheck((v) => !v)}
              title="Открыть детальную диагностику маршрута, связности дорог и препятствий"
            >
              <Icon name="route" size={13} /> Проверка маршрута
              <span
                className={`mono ml-1 ${
                  routeCheck.status === "valid"
                    ? "text-[#52d6bd]"
                    : routeCheck.status === "warnings" || routeCheck.status === "empty"
                      ? "text-[#f5b942]"
                      : "text-[#ff8080]"
                }`}
              >
                {routeCheck.status === "valid" ? "✓" : routeCheck.status === "errors" ? "✕" : "!"}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => downloadJson("custom-scenario.json", def, onNotify)}
            >
            <Icon name="download" size={13} /> Скачать JSON
          </button>
          <button
            type="button"
            className="btn btn-mini"
            title="Как выгрузить карту города в .osm / Overpass JSON / GeoJSON"
            onClick={() => setShowOsmHelp((v) => !v)}
          >
            Как импортировать?
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocked}
            title={blocked ? "Исправьте ошибки валидации" : "Открыть карту в 3D-тренажёре (пункт 4)"}
            onClick={onOpenInSimulator}
          >
            <Icon name="car" size={15} /> Открыть в тренажёре →
          </button>
        </div>
      </div>

      {/* Сворачиваемая памятка по офлайн-импорту карт */}
      {showOsmHelp && (
        <div className="panel p-4 text-[12px] text-[#c5d4de] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-extrabold text-white">Поддерживаемые форматы офлайн-импорта (до 30 МБ)</span>
            <button type="button" className="btn btn-mini" onClick={() => setShowOsmHelp(false)}>
              Скрыть
            </button>
          </div>
          <div className="grid sm:grid-cols-3 gap-3 text-[11px] text-[#9bafbc]">
            <div className="rounded-lg bg-[#091017] border hairline p-3">
              <div className="font-bold text-white mb-1">1. OpenStreetMap `.osm` (XML)</div>
              Выберите нужный квартал (300–600 м) на сайте openstreetmap.org или в JOSM → «Экспорт» → сохраните файл
              `.osm` и загрузите кнопкой «Импорт OSM / GeoJSON / JSON».
            </div>
            <div className="rounded-lg bg-[#091017] border hairline p-3">
              <div className="font-bold text-white mb-1">2. Overpass JSON и GeoJSON</div>
              Сохраните ответ Overpass API (`elements`) или `FeatureCollection` (`.geojson`). Автоматически
              переносятся дороги, здания, заборы, деревья, светофоры, зебры и дорожные знаки.
            </div>
            <div className="rounded-lg bg-[#091017] border hairline p-3">
              <div className="font-bold text-white mb-1">3. JSON сценария и бэкап</div>
              Любой файл `custom-scenario.json` или резервная копия `cdt.backup.v1` открывается для повторного
              редактирования и обмена между учебными ПК без интернета.
            </div>
          </div>
        </div>
      )}

      {/* Плашка атрибуции ODbL 1.0 для импортированной карты OpenStreetMap */}
      {def.mapMeta && (
        <div
          data-testid="editor-odbl-banner"
          className="panel px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#9bafbc]"
        >
          <span>
            <strong className="text-white">{def.mapMeta.source}</strong> · bbox [{def.mapMeta.bbox.join(", ")}] ·{" "}
            <strong className="text-[#52d6bd]">{def.mapMeta.attribution}</strong> ({def.mapMeta.license})
          </span>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="btn btn-mini text-[#f5b942]"
              onClick={() => setTool("boundary")}
              title="Нарисовать произвольный контур границы или задать коридор маршрута"
            >
              ⬠ Границы маршрута
            </button>
            {roads.length > 0 && (
              <button type="button" className="btn btn-mini" onClick={() => handleAutoRoute()}>
                <Icon name="route" size={12} /> Автомаршрут
              </button>
            )}
            <button type="button" className="btn btn-mini" onClick={() => setShowRouteCheck((v) => !v)}>
              {showRouteCheck ? "Скрыть проверку" : "Проверка маршрута"}
            </button>
            {rawOsmPack && (
              <button
                type="button"
                data-testid="editor-restore-osm-btn"
                className="btn btn-mini"
                onClick={handleRestoreFullOsm}
                title="Вернуть полную исходную выгрузку OSM до обрезки"
              >
                Вся выгрузка OSM
              </button>
            )}
          </div>
        </div>
      )}

      {/* Интерактивная панель «Проверка и настройка маршрута» (открывается автоматически после загрузки OSM) */}
      {showRouteCheck && (
        <div data-testid="route-check-panel" className="panel p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Chip
                tone={
                  routeCheck.status === "valid"
                    ? "mint"
                    : routeCheck.status === "warnings" || routeCheck.status === "empty"
                      ? "amber"
                      : "red"
                }
              >
                <span data-testid="route-check-status">
                  {routeCheck.status === "valid"
                    ? "✓ Маршрут проверен"
                    : routeCheck.status === "errors"
                      ? `✕ Ошибок: ${routeCheck.issues.filter((i) => i.severity === "error").length}`
                      : `⚠ Замечаний: ${routeCheck.issues.length}`}
                </span>
              </Chip>
              <span className="text-xs font-bold text-white" data-testid="route-check-summary">
                {routeCheck.summary}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {routeCheck.canAutoFix && (
                <button
                  type="button"
                  data-testid="editor-autofix-route-btn"
                  className="btn btn-primary btn-mini"
                  onClick={handleAutoFixRoute}
                >
                  Исправить маршрут
                </button>
              )}
              {roads.length > 0 && (
                <button
                  type="button"
                  data-testid="editor-deconflict-btn"
                  className="btn btn-mini text-[#52d6bd]"
                  onClick={handleDeconflictWithRoads}
                  title="Убрать с проезжей части конфликтующие здания, заборы, деревья, стойки знаков и выровнять маршрут по односторонним улицам"
                >
                  ✓ Согласовать с дорогами
                </button>
              )}
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => handleCorridorBoundary(true)}
                disabled={roads.length === 0 && def.checkpoints.length < 2}
                title="Обрезать карту по неквадратному коридору вдоль текущего маршрута"
              >
                ⬠ Коридор ±{corridorBufferM} м
              </button>
              <button
                type="button"
                aria-label={editorCollapsed.routeCheck ? "Развернуть проверку маршрута" : "Свернуть проверку маршрута"}
                title={editorCollapsed.routeCheck ? "Развернуть подробности проверки" : "Свернуть подробности проверки"}
                onClick={() => toggleEditorCollapse("routeCheck")}
                className="mono h-7 w-7 rounded-lg border hairline text-xs text-[#9bafbc] hover:text-[#f5b942]"
              >
                {editorCollapsed.routeCheck ? "+" : "−"}
              </button>
              <button
                type="button"
                aria-label="Закрыть проверку маршрута"
                title="Закрыть панель проверки маршрута"
                className="btn btn-mini"
                onClick={() => setShowRouteCheck(false)}
              >
                ✕
              </button>
            </div>
          </div>

          {!editorCollapsed.routeCheck && (
          <>
          {/* Выбор улицы OSM и пересборка маршрута */}
          {roads.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[#091017] border hairline px-3 py-2 text-[11px]">
              <span className="mono text-[10px] text-[#7c909d]">УЛИЦА МАРШРУТА:</span>
              <select
                data-testid="editor-route-candidate-select"
                value={routeCandidateId}
                onChange={(e) => setRouteCandidateId(e.target.value)}
                className="rounded-lg bg-[#0d1620] border hairline px-2 py-1 text-xs text-white max-w-[290px]"
              >
                <option value="">Автоматически (лучшая улица внутри границы)</option>
                {routeCandidates.slice(0, 20).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.oneway ? "→ " : ""}
                    {c.name} · {c.lengthM} м ({c.highway}, {c.speedLimitKmh} км/ч
                    {c.oneway ? ", 1-стор." : ""})
                  </option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-[#c5d4df]">
                <input
                  type="checkbox"
                  data-testid="editor-route-reverse-toggle"
                  checked={routeReverse}
                  onChange={(e) => setRouteReverse(e.target.checked)}
                  className="accent-[#f5b942]"
                />
                <span>В обратную сторону</span>
              </label>
              <button
                type="button"
                data-testid="editor-build-route-btn"
                className="btn btn-mini text-[#52d6bd]"
                onClick={() => handleAutoRoute(routeCandidateId, routeReverse)}
              >
                <Icon name="route" size={12} /> Построить маршрут
              </button>
              <span className="mono text-[10px] text-[#7c909d] ml-auto">
                КТ: {routeCheck.checkpointsCount} · длина: {routeCheck.totalLengthM} м · светофоров:{" "}
                {routeCheck.signalsOnRoute} · переходов: {routeCheck.crosswalksOnRoute} · знаков:{" "}
                {routeCheck.signsOnRoute}
              </span>
            </div>
          )}

          {/* Отчёт автоматического согласования с реальной картой OSM / GeoJSON */}
          {def.mapMeta &&
            ((def.mapMeta.conflictNotes && def.mapMeta.conflictNotes.length > 0) ||
              (def.mapMeta.onewayRoadsCount ?? 0) > 0 ||
              def.mapMeta.origin) && (
              <div
                data-testid="editor-osm-deconflict-notes"
                className="rounded-lg bg-[#081519] border border-[#52d6bd]/25 px-3 py-1.5 text-[11px] text-[#b7d4dc] flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                <span className="mono text-[10px] text-[#52d6bd] font-semibold">РЕАЛЬНАЯ КАРТА OSM:</span>
                {def.mapMeta.origin && (
                  <span className="mono text-[10px] text-[#8ab2bf]">
                    WGS84 {def.mapMeta.origin.lat.toFixed(5)}, {def.mapMeta.origin.lon.toFixed(5)}
                  </span>
                )}
                {(def.mapMeta.onewayRoadsCount ?? 0) > 0 && (
                  <span>· односторонних: {def.mapMeta.onewayRoadsCount}</span>
                )}
                {def.mapMeta.conflictNotes && def.mapMeta.conflictNotes.length > 0 && (
                  <span>· согласовано: {def.mapMeta.conflictNotes.join("; ")}</span>
                )}
              </div>
            )}

          {/* Замечания и ошибки с кнопкой перехода к объекту на 2D-карте */}
          {routeCheck.issues.length > 0 && (
            <div className="space-y-1.5" data-testid="route-check-issues">
              {routeCheck.issues.map((iss, issIdx) => (
                <div
                  key={issIdx}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[11px] border ${
                    iss.severity === "error"
                      ? "bg-[#3a1216]/45 border-[#ff6b6b]/35 text-[#ffb4b4]"
                      : iss.severity === "warning"
                        ? "bg-[#33260d]/40 border-[#f5b942]/30 text-[#f5d78a]"
                        : "bg-[#0d1c26]/60 border-white/10 text-[#b7c7d2]"
                  }`}
                >
                  <span>
                    <strong className="mono mr-1.5">
                      {iss.severity === "error" ? "ОШИБКА" : iss.severity === "warning" ? "СОВЕТ" : "ИНФО"}
                    </strong>
                    {iss.message}
                  </span>
                  {iss.target && (
                    <button
                      type="button"
                      className="btn btn-mini"
                      onClick={() => focusIssueTarget(iss.target)}
                    >
                      Показать на карте
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Сегменты маршрута (Старт → КТ #1 → ... → финиш) */}
          {routeCheck.legs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {routeCheck.legs.map((leg) => (
                <button
                  key={leg.index}
                  type="button"
                  onClick={() => focusIssueTarget({ kind: "checkpoint", id: leg.checkpointId })}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 border cursor-pointer mono ${
                    leg.status === "ok"
                      ? "bg-[#091a19] border-[#52d6bd]/30 text-[#9ce8d8]"
                      : leg.status === "offroad"
                        ? "bg-[#241b09] border-[#f5b942]/35 text-[#f5d78a]"
                        : "bg-[#2a1014] border-[#ff6b6b]/40 text-[#ff9e9e]"
                  }`}
                  title={
                    leg.blockedBy
                      ? `Препятствие: ${leg.blockedBy}`
                      : leg.roadNames.length > 0
                        ? leg.roadNames.join(" → ")
                        : leg.toLabel
                  }
                >
                  <span>
                    {leg.fromLabel} → {leg.toLabel}: {leg.lengthM} м
                  </span>
                  {leg.roadNames[0] && <span className="text-[#7c909d]">({leg.roadNames[0]})</span>}
                </button>
              ))}
            </div>
          )}
          </>
          )}
        </div>
      )}

      {/* Ошибки и предупреждения проверки геометрии (сворачиваемый и закрываемый блок) */}
      {(blocked || validation.warnings.length > 0) && !editorClosed.validation && (
        <div className="panel p-3.5 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="mono text-[10px] text-[#9bafbc]">
              ПРОВЕРКА ГЕОМЕТРИИ ({validation.errors.length + validation.warnings.length})
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={editorCollapsed.validation ? "Развернуть проверку геометрии" : "Свернуть проверку геометрии"}
                onClick={() => toggleEditorCollapse("validation")}
                className="mono h-5 w-5 rounded border hairline text-[10px] text-[#9bafbc] hover:text-[#f5b942]"
              >
                {editorCollapsed.validation ? "+" : "−"}
              </button>
              <button
                type="button"
                aria-label="Закрыть проверку геометрии"
                onClick={() => closeEditorCard("validation")}
                className="mono h-5 w-5 rounded border hairline text-[10px] text-[#9bafbc] hover:text-[#ff8080]"
              >
                ×
              </button>
            </div>
          </div>
          {!editorCollapsed.validation && (
            <>
              {validation.errors.map((e, i) => (
                <div key={`e${i}`} className="flex gap-2 text-[12px] text-[#ff9494]">
                  <Icon name="alert" size={14} className="shrink-0 mt-0.5" />
                  <span>{e}</span>
                </div>
              ))}
              {validation.warnings.map((w, i) => (
                <div key={`w${i}`} className="flex gap-2 text-[12px] text-[#f5d78a]">
                  <Icon name="alert" size={14} className="shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Панель быстрого возврата закрытых блоков редактора */}
      {(editorClosed.palette || editorClosed.inspector || editorClosed.objects || editorClosed.bounds || (editorClosed.validation && (blocked || validation.warnings.length > 0))) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="mono text-[10px] text-[#7c909d]">СКРЫТЫЕ ПАНЕЛИ:</span>
          {([
            ["palette", "Инструменты"],
            ["inspector", "Инспектор"],
            ["objects", "Объекты"],
            ["bounds", "Площадка и границы"],
            ["validation", "Проверка геометрии"],
          ] as const)
            .filter(([k]) =>
              k === "validation"
                ? Boolean(editorClosed.validation && (blocked || validation.warnings.length > 0))
                : Boolean(editorClosed[k])
            )
            .map(([k, lbl]) => (
              <button key={k} type="button" className="btn btn-mini text-[#52d6bd]" onClick={() => reopenEditorCard(k)}>
                + {lbl}
              </button>
            ))}
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              setEditorClosed({});
              setEditorCollapsed({});
            }}
          >
            Показать все
          </button>
        </div>
      )}

      {/* === [SEC:custom-car] Автомобиль заезда и список радиостанций/подключений сценария === */}
      {!editorClosed.palette && (
        <div className="panel p-3.5 space-y-3" data-testid="editor-car-panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-extrabold">Автомобиль заезда</span>
            <span className="mono text-[10px] text-[#9bafbc]">
              {getPlayerCar(def.playerCarId).name} · {getPlayerCar(def.playerCarId).gearbox}
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {PLAYER_CARS.map((car) => {
              const active = (def.playerCarId ?? DEFAULT_PLAYER_CAR_ID) === car.id;
              return (
                <button
                  key={car.id}
                  type="button"
                  data-testid={`editor-car-${car.id}`}
                  aria-pressed={active}
                  title={`${car.name} · ${car.engine} · ${car.gearbox} · ${car.length.toFixed(2)} м · Vmax ${car.vmaxKmh} км/ч`}
                  onClick={() => {
                    patchDef({ playerCarId: car.id });
                    onNotify(
                      active
                        ? `Учебная машина сценария: ${car.name}`
                        : `Учебная машина сценария: ${car.name} · ${car.engine} · ${car.gearbox}`
                    );
                  }}
                  className={`text-left rounded-lg p-2 border transition cursor-pointer ${
                    active
                      ? "bg-[#f5b942]/12 border-[#f5b942]/70 text-white"
                      : "bg-[#091017] border-white/10 text-[#c3d2dc] hover:border-white/25"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-white/25"
                      style={{ background: `#${car.color.toString(16).padStart(6, "0")}` }}
                    />
                    <span className="text-[11px] font-extrabold">{car.shortName}</span>
                    <span className="mono text-[10px] text-[#8fa2ae] ml-auto">{car.vmaxKmh} км/ч</span>
                  </span>
                  <span className="mono block text-[10px] text-[#8fa2ae]">
                    {car.length.toFixed(2)}×{car.width.toFixed(2)} м · база {car.wheelbase.toFixed(2)} м · {car.tyres}
                  </span>
                  <span className="block text-[10px] text-[#a9bcc8] mt-0.5">{car.blurb}</span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-white/10 pt-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-extrabold">Радиостанции и подключения</span>
              <span className="mono text-[10px] text-[#9bafbc]">
                {radioList.length} из {INTERNET_RADIO_STATIONS.length} в тюнере сценария
              </span>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {INTERNET_RADIO_STATIONS.map((st) => {
                const on = radioList.includes(st.id);
                return (
                  <label
                    key={st.id}
                    className={`flex items-start gap-2 rounded-lg px-2 py-1.5 border cursor-pointer transition ${
                      on ? "bg-[#0f1a24] border-[#52d6bd]/45" : "bg-[#091017] border-white/10"
                    }`}
                  >
                    <input
                      type="checkbox"
                      data-testid={`editor-radio-${st.id}`}
                      checked={on}
                      onChange={() => {
                        const next = on ? radioList.filter((id) => id !== st.id) : [...radioList, st.id];
                        // Пустой список радио недопустим: тюнеру нужен хотя бы один эфир
                        if (next.length === 0) {
                          onNotify("В тюнере должна остаться хотя бы одна станция");
                          return;
                        }
                        patchDef({ radioStationIds: next });
                        onNotify(on ? `Станция ${st.name} убрана из сценария` : `Станция ${st.name} добавлена в сценарий`);
                      }}
                      className="mt-0.5 accent-[#52d6bd]"
                    />
                    <span className="min-w-0">
                      <span className="mono text-[11px] text-white">
                        FM {st.freq} · {st.name}
                      </span>
                      <span className="mono block text-[10px] text-[#8fa2ae]">
                        {st.genre} · {st.streamUrl.replace(/^https?:\/\//, "").split("/")[0]}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn btn-mini"
                data-testid="editor-radio-all"
                onClick={() => {
                  patchDef({ radioStationIds: INTERNET_RADIO_STATIONS.map((st) => st.id) });
                  onNotify("В тюнер сценария добавлены все станции каталога");
                }}
              >
                Все станции
              </button>
              <button
                type="button"
                className="btn btn-mini"
                data-testid="editor-radio-saving"
                onClick={() => {
                  patchDef({ radioStationIds: ["record", "record-deep"] });
                  onNotify("Компактный список: RECORD и RECORD Deep — без лишних жанров");
                }}
              >
                Минимум FM
              </button>
              <span className="mono text-[10px] text-[#7c909d]">
                Тюнер ШГУ показывает именно этот список — станции вне сценария недоступны во время заезда.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* === [SEC:custom-preview] Палитра классов, действия Undo/Redo и интерактивный 2D-холст === */}
      {!editorClosed.palette && (
      <div className="panel p-3.5 space-y-3">
        {/* Инструменты палитры + Undo/Redo/Дубль/Удалить */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Инструменты редактора карт">
            {TOOL_BUTTONS.map((tb) => {
              const active = tool === tb.id;
              return (
                <button
                  key={tb.id}
                  type="button"
                  data-testid={`editor-tool-${tb.id}`}
                  onClick={() => setTool(tb.id)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    active
                      ? "bg-[#f5b942] text-[#17130a] shadow-[0_0_14px_rgba(245,185,66,.28)]"
                      : "bg-[#091017] text-[#c3d2dc] border hairline hover:text-white hover:border-white/20"
                  }`}
                >
                  <span className="mono text-[11px]">{tb.badge}</span>
                  <span>{tb.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="btn btn-mini"
              disabled={history.past.length === 0}
              title="Отменить последнее изменение (Ctrl+Z)"
              onClick={handleUndo}
            >
              ↶ Отмена ({history.past.length})
            </button>
            <button
              type="button"
              className="btn btn-mini"
              disabled={history.future.length === 0}
              title="Повторить отменённое изменение (Ctrl+Y)"
              onClick={handleRedo}
            >
              ↷ Повтор
            </button>
            <button
              type="button"
              className="btn btn-mini"
              disabled={!selection || selection.kind === "start"}
              title="Дублировать выбранный объект (Ctrl+D)"
              onClick={handleDuplicate}
            >
              Дубль
            </button>
            <button
              type="button"
              className="btn btn-mini text-[#ff9494]"
              disabled={!selection || selection.kind === "start"}
              title="Удалить выбранный объект (Delete)"
              onClick={handleDelete}
            >
              Удалить
            </button>
            <button
              type="button"
              aria-label={editorCollapsed.palette ? "Развернуть настройки палитры" : "Свернуть настройки палитры"}
              title={editorCollapsed.palette ? "Развернуть настройки палитры" : "Свернуть дополнительные строки палитры"}
              onClick={() => toggleEditorCollapse("palette")}
              className="mono h-7 w-7 rounded-lg border hairline text-xs text-[#9bafbc] hover:text-[#f5b942]"
            >
              {editorCollapsed.palette ? "+" : "−"}
            </button>
            <button
              type="button"
              aria-label="Закрыть палитру инструментов"
              title="Скрыть палитру инструментов (вернуть — кнопкой «+ Инструменты»)"
              onClick={() => closeEditorCard("palette")}
              className="mono h-7 w-7 rounded-lg border hairline text-xs text-[#9bafbc] hover:text-[#ff8080]"
            >
              ×
            </button>
          </div>
        </div>

        {!editorCollapsed.palette && (
        <>

        {/* Подпанель произвольных границ карты и обрезки загруженного маршрута OSM */}
        {tool === "boundary" && (
          <div
            data-testid="editor-boundary-panel"
            className="rounded-xl bg-[#091017] border border-[#f5b942]/35 p-3 space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="mono text-[10px] text-[#f5b942]">
                ПРОИЗВОЛЬНЫЕ ГРАНИЦЫ МАРШРУТА · НАРИСУЙТЕ МНОГОУГОЛЬНИК ПО ТОЧКАМ ИЛИ ПОСТРОЙТЕ КОРИДОР ВДОЛЬ УЛИЦЫ
              </span>
              <span className="mono text-[10px] text-[#9bafbc]">
                {def.boundaryPolygon && def.boundaryPolygon.length >= 3
                  ? `Активен контур: ${def.boundaryPolygon.length} вершин · S ≈ ${Math.round(polygonArea(def.boundaryPolygon))} м²`
                  : `Прямоугольник ${Math.round(def.bounds.maxX - def.bounds.minX)}×${Math.round(def.bounds.maxZ - def.bounds.minZ)} м`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mono text-[10px] text-[#8fa2ae]">ФОРМА ПЛОЩАДКИ:</span>
              {BOUNDARY_SHAPE_PRESETS.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  data-testid={`editor-shape-${pr.id}`}
                  className="btn btn-mini"
                  title={pr.hint}
                  onClick={() => handlePresetBoundary(pr.id)}
                >
                  ⬠ {pr.label}
                </button>
              ))}
              <label
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0d1620] border hairline px-2.5 py-1 text-[11px] cursor-pointer ml-auto"
                title="Добавляет физический 3D-бордюр по всем сторонам произвольной площадки/границы"
              >
                <input
                  type="checkbox"
                  data-testid="editor-perimeter-curb-toggle"
                  checked={Boolean(def.perimeterCurb)}
                  onChange={(e) => patchDef({ perimeterCurb: e.target.checked || undefined })}
                  className="accent-[#f5b942]"
                />
                <span>3D-бордюр по контуру</span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="inline-flex items-center gap-2 rounded-lg bg-[#0d1620] border hairline px-2.5 py-1">
                <span className="mono text-[10px] text-[#8fa2ae]">БУФЕР КОРИДОРА:</span>
                <input
                  type="range"
                  min={14}
                  max={120}
                  step={2}
                  value={corridorBufferM}
                  onChange={(e) => setCorridorBufferM(Number(e.target.value))}
                  className="w-24 accent-[#f5b942]"
                />
                <span className="mono text-[11px] text-white w-12">±{corridorBufferM} м</span>
              </label>

              <button
                type="button"
                data-testid="editor-corridor-btn"
                className="btn btn-mini text-[#52d6bd]"
                disabled={roads.length === 0 && def.checkpoints.length < 2}
                onClick={() => handleCorridorBoundary(false)}
                title="Построить неквадратный коридор вдоль активного маршрута"
              >
                ⬠ Коридор маршрута
              </button>

              <button
                type="button"
                data-testid="editor-hull-btn"
                className="btn btn-mini"
                onClick={handleHullBoundary}
                title="Обтянуть все дороги и точки выпуклым многоугольником"
              >
                ⬡ Оболочка улиц
              </button>

              <button
                type="button"
                data-testid="editor-crop-btn"
                className="btn btn-primary btn-mini"
                onClick={handleCropToBoundary}
                title="Подрезать все дороги и убрать здания/объекты за пределами текущей границы (отменяется Ctrl+Z)"
              >
                ✂ Обрезать по границе
              </button>

              {rawOsmPack && def.boundaryPolygon && (
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={handleRecropFromRawOsm}
                  title="Заново вырезать из полной исходной выгрузки OSM по текущему контуру"
                >
                  ↻ Вырезать из исходного OSM
                </button>
              )}

              {rawOsmPack && (
                <button type="button" className="btn btn-mini" onClick={handleRestoreFullOsm}>
                  Вся выгрузка OSM
                </button>
              )}

              {def.boundaryPolygon && (
                <button
                  type="button"
                  data-testid="editor-reset-boundary-btn"
                  className="btn btn-mini text-[#f5d78a]"
                  onClick={handleResetBoundaryToRect}
                >
                  Сбросить в прямоугольник
                </button>
              )}
            </div>

            <div className="text-[11px] text-[#8fa2ae]">
              Совет: кликайте по карте, чтобы нарисовать контур любой формы (Г-образный, диагональный, вдоль квартала),
              затем нажмите <b>«✓ Замкнуть»</b> или <b>«✂ Замкнуть и обрезать»</b>. Бирюзовые кружки на рёбрах добавляют
              новые вершины, янтарные квадраты перетаскиваются мышью, <span className="mono">Delete</span> удаляет вершину.
            </div>
          </div>
        )}

        {/* Подпанель выбора класса знака */}
        {tool === "sign" && (
          <div className="rounded-xl bg-[#091017] border hairline p-3 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="mono text-[10px] text-[#8fa2ae]">
                ВЫБЕРИТЕ ДОРОЖНЫЙ ЗНАК И КЛИКНИТЕ ПО КАРТЕ (КУРС УСТАНОВКИ: {placeHeadingDeg}°)
              </span>
              <div className="flex items-center gap-1">
                {([
                  ["↑ 0°", 0],
                  ["→ −90°", -90],
                  ["↓ 180°", 180],
                  ["← +90°", 90],
                ] as const).map(([lbl, deg]) => (
                  <button
                    key={lbl}
                    type="button"
                    className={`btn btn-mini ${placeHeadingDeg === deg ? "border-[#f5b942] text-[#f5b942]" : ""}`}
                    onClick={() => setPlaceHeadingDeg(deg)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
              {ROAD_SIGN_CATALOG.map((sp) => {
                const active = signKind === sp.kind;
                return (
                  <button
                    key={sp.kind}
                    type="button"
                    data-testid={`palette-sign-${sp.kind}`}
                    onClick={() => setSignKind(sp.kind)}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition cursor-pointer border ${
                      active
                        ? "bg-[#f5b942]/15 border-[#f5b942] text-white"
                        : "bg-[#0d1620] border-white/10 text-[#b7c7d2] hover:border-white/25"
                    }`}
                  >
                    <span
                      className="mono inline-grid place-items-center h-6 min-w-6 px-1 rounded text-[10px] font-extrabold shrink-0"
                      style={{
                        backgroundColor: sp.bgColor,
                        color: sp.textColor,
                        border: `2px solid ${sp.borderColor}`,
                      }}
                    >
                      {sp.kind === "speed_limit" ? signSpeedLimit : sp.shortLabel}
                    </span>
                    <span className="truncate leading-tight">
                      <span className="block mono text-[9px] text-[#7c909d]">{sp.code}</span>
                      <span className="block font-semibold truncate">{sp.title}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {signKind === "speed_limit" && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="mono text-[10px] text-[#7c909d]">СКОРОСТЬ НА ЗНАКЕ 3.24:</span>
                {SPEED_PRESETS.map((kmh) => (
                  <button
                    key={kmh}
                    type="button"
                    className={`btn btn-mini ${signSpeedLimit === kmh ? "border-[#f5b942] text-[#f5b942]" : ""}`}
                    onClick={() => setSignSpeedLimit(kmh)}
                  >
                    {kmh} км/ч
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Подпанель выбора класса препятствия / объекта окружения */}
        {tool === "obstacle" && (
          <div className="rounded-xl bg-[#091017] border hairline p-3 space-y-2">
            <div className="mono text-[10px] text-[#8fa2ae]">КЛАСС ОБЪЕКТА / ПРЕПЯТСТВИЯ (КЛИК ПО КАРТЕ)</div>
            <div className="flex flex-wrap gap-1.5">
              {OBSTACLE_CATALOG.map((ob) => (
                <button
                  key={ob.kind}
                  type="button"
                  data-testid={`palette-obstacle-${ob.kind}`}
                  onClick={() => setObstacleKind(ob.kind)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold border cursor-pointer ${
                    obstacleKind === ob.kind
                      ? "bg-[#f5b942]/15 border-[#f5b942] text-white"
                      : "bg-[#0d1620] border-white/10 text-[#b7c7d2] hover:border-white/25"
                  }`}
                >
                  <span
                    className="h-3 w-3 rounded-sm shrink-0"
                    style={{ backgroundColor: ob.mapFill, border: `1px solid ${ob.mapStroke}` }}
                  />
                  {ob.title}
                </button>
              ))}
            </div>
            {obstacleKind === "parked_car" && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="mono text-[10px] text-[#7c909d]">МОДЕЛЬ АВТО:</span>
                {PARKED_MODELS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`btn btn-mini ${parkedModel === m ? "border-[#f5b942] text-[#f5b942]" : ""}`}
                    onClick={() => setParkedModel(m)}
                  >
                    {VEHICLE_DIMS[m].name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Подпанель выбора типа парковочного бокса */}
        {tool === "bay" && (
          <div className="rounded-xl bg-[#091017] border hairline p-3 flex flex-wrap items-center gap-2">
            <span className="mono text-[10px] text-[#8fa2ae]">ТИП ПАРКОВОЧНОГО МЕСТА:</span>
            {BAY_KINDS.map((bk) => (
              <button
                key={bk.v}
                type="button"
                className={`btn btn-mini ${bayKind === bk.v ? "border-[#f5b942] text-[#f5b942]" : ""}`}
                onClick={() => setBayKind(bk.v)}
              >
                {bk.l}
              </button>
            ))}
          </div>
        )}

        {/* Привязка к сетке, видимость слоёв и готовые шаблоны */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t hairline text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="mono text-[10px] text-[#7c909d] cursor-help"
              title="Метрическая сетка на карте и шаг привязки координат/углов для ровного выравнивания боксов, бордюров, знаков и вершин площадки. «Выкл» скрывает сетку и включает свободный перенос."
            >
              СЕТКА:
            </span>
            {SNAP_OPTIONS.map((so) => (
              <button
                key={so.v}
                type="button"
                data-testid={`editor-grid-${so.v}`}
                title={so.hint}
                onClick={() => setSnapStep(so.v)}
                className={`px-2 py-0.5 rounded mono text-[10px] cursor-pointer border ${
                  snapStep === so.v
                    ? "bg-[#52d6bd]/15 border-[#52d6bd]/50 text-[#52d6bd]"
                    : "bg-[#091017] border-white/10 text-[#8fa2ae] hover:text-white"
                }`}
              >
                {so.l}
              </button>
            ))}
            <span className="mono text-[10px] text-[#7c909d] ml-2">СЛОИ:</span>
            {LAYER_LABELS.map((ly) => {
              const on = layers[ly.k];
              return (
                <button
                  key={ly.k}
                  type="button"
                  onClick={() => setLayers((prev) => ({ ...prev, [ly.k]: !prev[ly.k] }))}
                  className={`px-2 py-0.5 rounded text-[10px] cursor-pointer border ${
                    on
                      ? "bg-white/[0.06] border-white/20 text-[#dbe7ee]"
                      : "bg-transparent border-white/5 text-[#5a6d7a] line-through"
                  }`}
                >
                  {ly.l}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <span className="mono text-[10px] text-[#7c909d]">ШАБЛОНЫ:</span>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                applyImportedScenario(defaultCustomScenario(), "Восстановлен стартовый шаблон площадки", {
                  rawPack: null,
                  openCheck: false,
                })
              }
            >
              Площадка
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                applyImportedScenario(
                  customFromWorld(buildPerpendicularScenario(calibration), "Мой бокс 90°"),
                  "Шаблон: копия «Бокс 90°»",
                  { rawPack: null, openCheck: false }
                )
              }
            >
              Бокс 90°
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                applyImportedScenario(
                  customFromWorld(buildParallelScenario(calibration), "Моя параллельная"),
                  "Шаблон: копия «Параллельная»",
                  { rawPack: null, openCheck: false }
                )
              }
            >
              Параллельная
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                applyImportedScenario(
                  customFromWorld(buildCityOsmScenario(calibration), "Мой городской маршрут"),
                  "Шаблон: копия «Город OSM» со светофорами, знаком 40 и переходом",
                  { rawPack: null, openCheck: true }
                )
              }
            >
              Город OSM
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                applyImportedScenario(emptyCustomScenario(), "Создана чистая учебная карта", {
                  rawPack: null,
                  openCheck: false,
                })
              }
            >
              Пустая
            </button>
          </div>
        </div>
        </>
        )}
      </div>
      )}

      {/* Основная рабочая область: слева 2D-холст (на всю ширину, если правые панели закрыты), справа инспектор */}
      <div className={`grid gap-4 items-start ${anySidebarOpen ? "xl:grid-cols-[1fr_410px]" : ""}`}>
        <MapCanvasEditor
          def={def}
          tool={tool}
          selection={selection}
          snapStep={snapStep}
          layers={layers}
          placeOptions={placeOptions}
          routeCheck={routeCheck}
          draftBoundary={draftBoundary}
          onDraftBoundaryChange={setDraftBoundary}
          onFinishBoundary={handleFinishBoundary}
          onCancelBoundary={handleCancelBoundary}
          fitSignal={fitSignal}
          focusSignal={focusSignal}
          onSelect={setSelection}
          onLiveChange={onChange}
          onCommitChange={commitChange}
        />

        {/* === [SEC:custom-forms] Инспектор выбранного объекта, реестр и параметры карты === */}
        {anySidebarOpen && (
        <div className="space-y-4 min-w-0">
          {/* Инспектор свойств выбранного объекта */}
          {!editorClosed.inspector && (
          <div className="panel p-4 space-y-3" data-testid="editor-inspector">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="mono text-[10px] text-[#7c909d]">ИНСПЕКТОР ОБЪЕКТА</div>
                <div className="text-sm font-extrabold text-white">
                  {selectedAnchor ? selectedAnchor.label : "Объект не выбран"}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
              {selectedAnchor && !editorCollapsed.inspector && (
                <div className="flex flex-wrap items-center gap-1" title="Поворот и порядок слоёв объекта">
                  {primary &&
                    ["obstacle", "bay", "sign", "signal", "crosswalk", "road"].includes(primary.kind) && (
                      <button
                        type="button"
                        data-testid="editor-bring-front-btn"
                        className="btn btn-mini"
                        title="Поместить объект на передний план/слой (также по удержанию 0,4 с на карте)"
                        onClick={handleBringSelectedToFront}
                      >
                        ↑ Наверх
                      </button>
                    )}
                  {selectedAnchor.h !== null && (
                    <>
                      <button type="button" className="btn btn-mini" onClick={() => handleQuickRotate(90)}>
                        ↺ 90°
                      </button>
                      <button type="button" className="btn btn-mini" onClick={() => handleQuickRotate(15)}>
                        ↺ 15°
                      </button>
                      <button type="button" className="btn btn-mini" onClick={() => handleQuickRotate(-15)}>
                        ↻ 15°
                      </button>
                      <button type="button" className="btn btn-mini" onClick={() => handleQuickRotate(-90)}>
                        ↻ 90°
                      </button>
                    </>
                  )}
                </div>
              )}
                <button
                  type="button"
                  aria-label={editorCollapsed.inspector ? "Развернуть инспектор" : "Свернуть инспектор"}
                  title={editorCollapsed.inspector ? "Развернуть инспектор" : "Свернуть инспектор"}
                  onClick={() => toggleEditorCollapse("inspector")}
                  className="mono h-6 w-6 rounded-md border hairline text-xs text-[#9bafbc] hover:text-[#f5b942]"
                >
                  {editorCollapsed.inspector ? "+" : "−"}
                </button>
                <button
                  type="button"
                  aria-label="Закрыть инспектор"
                  title="Закрыть инспектор (вернуть — «+ Инспектор»)"
                  onClick={() => closeEditorCard("inspector")}
                  className="mono h-6 w-6 rounded-md border hairline text-xs text-[#9bafbc] hover:text-[#ff8080]"
                >
                  ×
                </button>
              </div>
            </div>

            {!editorCollapsed.inspector && (
            <>

            {!primary && (
              <p className="text-[12px] text-[#8fa2ae] leading-relaxed">
                Кликните по любому объекту на 2D-карте (или в реестре ниже), чтобы перетащить его мышью, повернуть или
                изменить точные размеры и параметры. Для добавления выберите класс в палитре сверху.
              </p>
            )}

            {/* Инспектор: Вершина произвольной границы маршрута */}
            {primary?.kind === "boundary_point" && def.boundaryPolygon && def.boundaryPolygon[primary.index] && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <NumField
                    label="ВЕРШИНА X, М"
                    value={def.boundaryPolygon[primary.index].x}
                    step={1}
                    onChange={(v) =>
                      commitChange(
                        moveSelected(def, primary, v, def.boundaryPolygon![primary.index].z, 0),
                        def
                      )
                    }
                  />
                  <NumField
                    label="ВЕРШИНА Z, М"
                    value={def.boundaryPolygon[primary.index].z}
                    step={1}
                    onChange={(v) =>
                      commitChange(
                        moveSelected(def, primary, def.boundaryPolygon![primary.index].x, v, 0),
                        def
                      )
                    }
                  />
                </div>
                <div className="mono text-[10px] text-[#8fa2ae]">
                  ВЕРШИН: {def.boundaryPolygon.length} · ПЛОЩАДЬ:{" "}
                  {Math.round(polygonArea(def.boundaryPolygon))} м²
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      const ins = insertBoundaryPoint(def, primary.index);
                      if (!ins) return;
                      commitChange(ins.def, def);
                      setSelection(ins.selection);
                    }}
                  >
                    + Вершина после
                  </button>
                  <button type="button" className="btn btn-mini text-[#52d6bd]" onClick={handleCropToBoundary}>
                    ✂ Обрезать карту
                  </button>
                  <button type="button" className="btn btn-mini text-[#ff9494]" onClick={handleDelete}>
                    {def.boundaryPolygon.length > 3 ? "Удалить вершину" : "Сбросить контур"}
                  </button>
                </div>
              </div>
            )}

            {/* Инспектор: Старт автомобиля */}
            {primary?.kind === "start" && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X, М"
                    value={def.start.x}
                    onChange={(v) => patchDef({ start: { ...def.start, x: v } })}
                  />
                  <NumField
                    label="Z, М"
                    value={def.start.z}
                    onChange={(v) => patchDef({ start: { ...def.start, z: v } })}
                  />
                  <NumField
                    label="КУРС, °"
                    value={radToDeg(def.start.h)}
                    step={5}
                    min={-180}
                    max={180}
                    onChange={(v) => patchDef({ start: { ...def.start, h: degToRad(v) } })}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ["↑ 0° (север)", 0],
                    ["→ −90° (восток)", -90],
                    ["↓ 180° (юг)", 180],
                    ["← +90° (запад)", 90],
                  ] as const).map(([lbl, deg]) => (
                    <button
                      key={lbl}
                      type="button"
                      className="btn btn-mini"
                      onClick={() => patchDef({ start: { ...def.start, h: degToRad(deg) } })}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Инспектор: Дорожный знак */}
            {selectedSign && (
              <div className="space-y-3">
                <label className="block">
                  <span className="mono text-[10px] text-[#7c909d] block mb-1">КЛАСС ДОРОЖНОГО ЗНАКА</span>
                  <select
                    value={selectedSign.kind}
                    onChange={(e) => {
                      const nextKind = e.target.value as RoadSignKind;
                      const spec = getRoadSignSpec(nextKind);
                      patchDef({
                        signs: signs.map((s) =>
                          s.id !== selectedSign.id
                            ? s
                            : {
                                ...s,
                                kind: nextKind,
                                limitKmh: isSpeedSignKind(nextKind)
                                  ? s.limitKmh ?? spec.defaultLimitKmh ?? 40
                                  : undefined,
                                zoneRadius: isSpeedSignKind(nextKind)
                                  ? s.zoneRadius ?? spec.defaultZoneRadius ?? 24
                                  : undefined,
                                zoneX: isSpeedSignKind(nextKind) ? s.zoneX ?? s.x : undefined,
                                zoneZ: isSpeedSignKind(nextKind) ? s.zoneZ ?? s.z : undefined,
                                label:
                                  nextKind === "speed_limit"
                                    ? `Знак ${spec.code} «${s.limitKmh ?? spec.defaultLimitKmh ?? 40} км/ч»`
                                    : `Знак ${spec.code} «${spec.title}»`,
                              }
                        ),
                      });
                    }}
                    className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
                  >
                    {ROAD_SIGN_CATALOG.map((sp) => (
                      <option key={sp.kind} value={sp.kind}>
                        {sp.code} · {sp.title}
                      </option>
                    ))}
                  </select>
                </label>

                <TextField
                  label="ПОДПИСЬ"
                  value={selectedSign.label ?? ""}
                  onChange={(v) =>
                    patchDef({ signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, label: v } : s)) })
                  }
                />

                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X СТОЙКИ, М"
                    value={selectedSign.x}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({ signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, x: v } : s)) })
                    }
                  />
                  <NumField
                    label="Z СТОЙКИ, М"
                    value={selectedSign.z}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({ signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, z: v } : s)) })
                    }
                  />
                  <NumField
                    label="ПОТОК, °"
                    value={radToDeg(selectedSign.h)}
                    step={5}
                    min={-180}
                    max={180}
                    onChange={(v) => commitChange(setSelectedHeading(def, selectedSignSel(selectedSign.id), degToRad(v)), def)}
                  />
                </div>

                {isSpeedSignKind(selectedSign.kind) && (
                  <div className="rounded-lg bg-[#091017] border hairline p-2.5 space-y-2">
                    <div className="mono text-[10px] text-[#f5b942]">АКТИВНАЯ ЗОНА ОГРАНИЧЕНИЯ СКОРОСТИ</div>
                    <div className="grid grid-cols-2 gap-2">
                      <NumField
                        label="ЛИМИТ, КМ/Ч"
                        value={selectedSign.limitKmh ?? 40}
                        step={5}
                        min={5}
                        max={130}
                        onChange={(v) =>
                          patchDef({
                            signs: signs.map((s) =>
                              s.id === selectedSign.id
                                ? {
                                    ...s,
                                    limitKmh: v,
                                    label:
                                      s.kind === "speed_limit"
                                        ? `Знак 3.24 «${v} км/ч»`
                                        : `Знак 5.21 «Жилая зона» (${v} км/ч)`,
                                  }
                                : s
                            ),
                          })
                        }
                      />
                      <NumField
                        label="РАДИУС ЗОНЫ, М"
                        value={selectedSign.zoneRadius ?? 24}
                        step={1}
                        min={0}
                        max={250}
                        onChange={(v) =>
                          patchDef({
                            signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, zoneRadius: v } : s)),
                          })
                        }
                      />
                      <NumField
                        label="ЦЕНТР ЗОНЫ X"
                        value={selectedSign.zoneX ?? selectedSign.x}
                        step={0.5}
                        onChange={(v) =>
                          patchDef({
                            signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, zoneX: v } : s)),
                          })
                        }
                      />
                      <NumField
                        label="ЦЕНТР ЗОНЫ Z"
                        value={selectedSign.zoneZ ?? selectedSign.z}
                        step={0.5}
                        onChange={(v) =>
                          patchDef({
                            signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, zoneZ: v } : s)),
                          })
                        }
                      />
                    </div>
                  </div>
                )}

                <div className="text-[11px] text-[#8fa2ae] leading-relaxed">
                  {getRoadSignSpec(selectedSign.kind).effectNote}
                </div>

                <button
                  type="button"
                  className="btn btn-mini w-full justify-center"
                  onClick={() => {
                    const res = attachCheckpointToSign(def, selectedSign.id);
                    if (!res) return;
                    commitChange(res.def, def);
                    setSelection({ kind: "checkpoint", id: res.checkpointId });
                    onNotify(`Добавлена связанная точка маршрута ${res.checkpointId}`);
                  }}
                >
                  <Icon name="route" size={13} /> + Связать с КТ маршрута
                </button>
              </div>
            )}

            {/* Инспектор: Светофор */}
            {selectedSignal && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X СТОЙКИ"
                    value={selectedSignal.x}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({ signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, x: v } : s)) })
                    }
                  />
                  <NumField
                    label="Z СТОЙКИ"
                    value={selectedSignal.z}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({ signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, z: v } : s)) })
                    }
                  />
                  <NumField
                    label="ПОТОК, °"
                    value={radToDeg(selectedSignal.h)}
                    step={5}
                    min={-180}
                    max={180}
                    onChange={(v) =>
                      commitChange(setSelectedHeading(def, { kind: "signal", id: selectedSignal.id }, degToRad(v)), def)
                    }
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="СТОП-ЛИНИЯ X"
                    value={selectedSignal.stopLineX}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({
                        signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, stopLineX: v } : s)),
                      })
                    }
                  />
                  <NumField
                    label="СТОП-ЛИНИЯ Z"
                    value={selectedSignal.stopLineZ}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({
                        signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, stopLineZ: v } : s)),
                      })
                    }
                  />
                  <NumField
                    label="ШИРИНА 1.12"
                    value={selectedSignal.stopLineWidth}
                    step={0.2}
                    min={1.5}
                    max={24}
                    onChange={(v) =>
                      patchDef({
                        signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, stopLineWidth: v } : s)),
                      })
                    }
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="ЗЕЛЁНЫЙ, С"
                    value={selectedSignal.greenDuration}
                    step={1}
                    min={3}
                    max={180}
                    onChange={(v) =>
                      patchDef({
                        signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, greenDuration: v } : s)),
                      })
                    }
                  />
                  <NumField
                    label="КРАСНЫЙ, С"
                    value={selectedSignal.redDuration}
                    step={1}
                    min={3}
                    max={180}
                    onChange={(v) =>
                      patchDef({
                        signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, redDuration: v } : s)),
                      })
                    }
                  />
                  <NumField
                    label="СДВИГ ФАЗЫ, С"
                    value={selectedSignal.cycleOffset}
                    step={1}
                    min={0}
                    max={180}
                    onChange={(v) =>
                      patchDef({
                        signals: signals.map((s) => (s.id === selectedSignal.id ? { ...s, cycleOffset: v } : s)),
                      })
                    }
                  />
                </div>
              </div>
            )}

            {/* Инспектор: Пешеходный переход */}
            {selectedCrosswalk && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X ЦЕНТРА"
                    value={selectedCrosswalk.cx}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) => (c.id === selectedCrosswalk.id ? { ...c, cx: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="Z ЦЕНТРА"
                    value={selectedCrosswalk.cz}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) => (c.id === selectedCrosswalk.id ? { ...c, cz: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="КУРС ДОРОГИ, °"
                    value={radToDeg(selectedCrosswalk.h)}
                    step={5}
                    min={-180}
                    max={180}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) =>
                          c.id === selectedCrosswalk.id ? { ...c, h: degToRad(v) } : c
                        ),
                      })
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <NumField
                    label="ШИРИНА ДОРОГИ, М"
                    value={selectedCrosswalk.width}
                    step={0.5}
                    min={2}
                    max={30}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) => (c.id === selectedCrosswalk.id ? { ...c, width: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="ДЛИНА ЗЕБРЫ, М"
                    value={selectedCrosswalk.length}
                    step={0.2}
                    min={1.5}
                    max={15}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) => (c.id === selectedCrosswalk.id ? { ...c, length: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="СКОР. ПЕШЕХОДА, М/С"
                    value={selectedCrosswalk.pedSpeed}
                    step={0.1}
                    min={0}
                    max={3}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) => (c.id === selectedCrosswalk.id ? { ...c, pedSpeed: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="СДВИГ ФАЗЫ, С"
                    value={selectedCrosswalk.pedPhaseOffset}
                    step={0.5}
                    min={0}
                    max={60}
                    onChange={(v) =>
                      patchDef({
                        crosswalks: crosswalks.map((c) =>
                          c.id === selectedCrosswalk.id ? { ...c, pedPhaseOffset: v } : c
                        ),
                      })
                    }
                  />
                </div>
              </div>
            )}

            {/* Инспектор: Дорога */}
            {selectedRoad && (
              <div className="space-y-2.5">
                <TextField
                  label="НАЗВАНИЕ УЛИЦЫ"
                  value={selectedRoad.name ?? ""}
                  placeholder="ул. Учебная"
                  onChange={(v) =>
                    patchDef({ roads: roads.map((r) => (r.id === selectedRoad.id ? { ...r, name: v } : r)) })
                  }
                />
                <label className="block">
                  <span className="mono text-[10px] text-[#7c909d] block mb-1">КЛАСС ДОРОГИ (OSM HIGHWAY)</span>
                  <select
                    value={selectedRoad.highway}
                    onChange={(e) =>
                      patchDef({
                        roads: roads.map((r) => (r.id === selectedRoad.id ? { ...r, highway: e.target.value } : r)),
                      })
                    }
                    className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
                  >
                    {HIGHWAY_TYPES.map((ht) => (
                      <option key={ht.v} value={ht.v}>
                        {ht.l}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="ШИРИНА, М"
                    value={selectedRoad.width}
                    step={0.5}
                    min={2.5}
                    max={30}
                    onChange={(v) =>
                      patchDef({ roads: roads.map((r) => (r.id === selectedRoad.id ? { ...r, width: v } : r)) })
                    }
                  />
                  <NumField
                    label="ПОЛОС"
                    value={selectedRoad.lanes}
                    step={1}
                    min={1}
                    max={6}
                    onChange={(v) =>
                      patchDef({
                        roads: roads.map((r) =>
                          r.id === selectedRoad.id ? { ...r, lanes: Math.max(1, Math.min(6, Math.round(v))) } : r
                        ),
                      })
                    }
                  />
                  <NumField
                    label="ЛИМИТ, КМ/Ч"
                    value={selectedRoad.speedLimitKmh ?? 40}
                    step={5}
                    min={5}
                    max={110}
                    onChange={(v) =>
                      patchDef({
                        roads: roads.map((r) => (r.id === selectedRoad.id ? { ...r, speedLimitKmh: v } : r)),
                      })
                    }
                  />
                </div>
                <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedRoad.hasSolidCenter)}
                    onChange={(e) =>
                      patchDef({
                        roads: roads.map((r) =>
                          r.id === selectedRoad.id ? { ...r, hasSolidCenter: e.target.checked } : r
                        ),
                      })
                    }
                    className="accent-[#f5b942]"
                  />
                  <span>Сплошная осевая 1.1 (иначе прерывистая 1.5)</span>
                </label>
                <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="editor-road-oneway-toggle"
                    checked={Boolean(selectedRoad.oneway)}
                    onChange={(e) =>
                      patchDef({
                        roads: roads.map((r) =>
                          r.id === selectedRoad.id ? { ...r, oneway: e.target.checked } : r
                        ),
                      })
                    }
                    className="accent-[#52d6bd]"
                  />
                  <span>Одностороннее движение (OSM oneway / 5.5)</span>
                </label>
                {selection?.kind === "road_point" &&
                  selection.id === selectedRoad.id &&
                  selectedRoad.points[selection.index] && (
                    <div className="rounded-lg bg-[#091017] border hairline p-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="mono text-[10px] text-[#52d6bd]">
                          ВЫБРАН УЗЕЛ #{selection.index + 1} ИЗ {selectedRoad.points.length}
                        </span>
                        {selectedRoad.points.length > 2 && (
                          <button type="button" className="btn btn-mini text-[#ff9494]" onClick={handleDelete}>
                            Удалить узел
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <NumField
                          label="УЗЕЛ X, М"
                          value={selectedRoad.points[selection.index].x}
                          step={0.5}
                          onChange={(v) =>
                            commitChange(
                              moveSelected(def, selection, v, selectedRoad.points[selection.index].z, 0),
                              def
                            )
                          }
                        />
                        <NumField
                          label="УЗЕЛ Z, М"
                          value={selectedRoad.points[selection.index].z}
                          step={0.5}
                          onChange={(v) =>
                            commitChange(
                              moveSelected(def, selection, selectedRoad.points[selection.index].x, v, 0),
                              def
                            )
                          }
                        />
                      </div>
                    </div>
                  )}
                <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1">
                  <span className="mono text-[10px] text-[#7c909d]">УЗЛОВ: {selectedRoad.points.length}</span>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="btn btn-mini"
                      title="Развернуть направление узлов улицы (для односторонних дорог и автомаршрута)"
                      onClick={() => {
                        commitChange(reverseRoadDirection(def, selectedRoad.id), def);
                        onNotify("Направление улицы развёрнуто");
                      }}
                    >
                      ⇄ Реверс
                    </button>
                    <button
                      type="button"
                      className="btn btn-mini text-[#52d6bd]"
                      title="Построить маршрут по этой улице"
                      onClick={() => handleAutoRoute(selectedRoad.id, false)}
                    >
                      Маршрут тут
                    </button>
                    <button
                      type="button"
                      className="btn btn-mini"
                      onClick={() => {
                        const res = appendRoadPoint(def, selectedRoad.id);
                        commitChange(res.def, def);
                        setSelection({ kind: "road_point", id: selectedRoad.id, index: res.pointIndex });
                      }}
                    >
                      + Продлить узел
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Инспектор: Парковочный бокс */}
            {selectedBay && (
              <div className="space-y-2.5">
                <TextField
                  label="ПОДПИСЬ"
                  value={selectedBay.label}
                  onChange={(v) =>
                    patchDef({ bays: def.bays.map((b) => (b.id === selectedBay.id ? { ...b, label: v } : b)) })
                  }
                />
                <label className="block">
                  <span className="mono text-[10px] text-[#7c909d] block mb-1">ТИП БОКСА</span>
                  <select
                    value={selectedBay.kind}
                    onChange={(e) => {
                      const kind = e.target.value as ParkingBayKind;
                      patchDef({
                        bays: def.bays.map((b) =>
                          b.id === selectedBay.id
                            ? { ...b, kind, openSide: kind === "parallel" ? "left" : "front" }
                            : b
                        ),
                      });
                    }}
                    className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
                  >
                    {BAY_KINDS.map((bk) => (
                      <option key={bk.v} value={bk.v}>
                        {bk.l}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X, М"
                    value={selectedBay.cx}
                    onChange={(v) =>
                      patchDef({ bays: def.bays.map((b) => (b.id === selectedBay.id ? { ...b, cx: v } : b)) })
                    }
                  />
                  <NumField
                    label="Z, М"
                    value={selectedBay.cz}
                    onChange={(v) =>
                      patchDef({ bays: def.bays.map((b) => (b.id === selectedBay.id ? { ...b, cz: v } : b)) })
                    }
                  />
                  <NumField
                    label="УГОЛ, °"
                    value={radToDeg(selectedBay.h)}
                    step={5}
                    min={-180}
                    max={180}
                    onChange={(v) =>
                      patchDef({
                        bays: def.bays.map((b) => (b.id === selectedBay.id ? { ...b, h: degToRad(v) } : b)),
                      })
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <NumField
                    label="ШИРИНА, М"
                    value={selectedBay.width}
                    min={1.9}
                    max={8}
                    onChange={(v) =>
                      patchDef({ bays: def.bays.map((b) => (b.id === selectedBay.id ? { ...b, width: v } : b)) })
                    }
                  />
                  <NumField
                    label="ДЛИНА, М"
                    value={selectedBay.length}
                    min={4.4}
                    max={12}
                    onChange={(v) =>
                      patchDef({ bays: def.bays.map((b) => (b.id === selectedBay.id ? { ...b, length: v } : b)) })
                    }
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedBay.occupied}
                      onChange={(e) =>
                        patchDef({
                          bays: def.bays.map((b) =>
                            b.id === selectedBay.id
                              ? {
                                  ...b,
                                  occupied: e.target.checked,
                                  parkedModel: e.target.checked ? b.parkedModel ?? "rio" : undefined,
                                }
                              : b
                          ),
                        })
                      }
                      className="accent-[#f5b942]"
                    />
                    <span>Занят автомобилем</span>
                  </label>
                  {selectedBay.occupied && (
                    <select
                      value={selectedBay.parkedModel ?? "rio"}
                      onChange={(e) =>
                        patchDef({
                          bays: def.bays.map((b) =>
                            b.id === selectedBay.id ? { ...b, parkedModel: e.target.value as ParkedModelKey } : b
                          ),
                        })
                      }
                      className="rounded-lg bg-[#091017] border hairline px-2 py-1 text-xs text-white"
                    >
                      {PARKED_MODELS.map((m) => (
                        <option key={m} value={m}>
                          {VEHICLE_DIMS[m].name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            {/* Инспектор: Препятствие / объект окружения (8 классов) */}
            {selectedObstacle && (
              <div className="space-y-2.5">
                <label className="block">
                  <span className="mono text-[10px] text-[#7c909d] block mb-1">КЛАСС ОБЪЕКТА</span>
                  <select
                    value={selectedObstacle.kind}
                    onChange={(e) => {
                      const k = e.target.value as ObstacleKind;
                      const sp = getObstacleSpec(k);
                      patchDef({
                        obstacles: def.obstacles.map((o) =>
                          o.id === selectedObstacle.id
                            ? {
                                ...o,
                                kind: k,
                                halfX: sp.halfX,
                                halfZ: sp.halfZ,
                                height: sp.height,
                                color: sp.color,
                                model: k === "parked_car" ? o.model ?? "rio" : undefined,
                                label: sp.defaultLabel,
                              }
                            : o
                        ),
                      });
                    }}
                    className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
                  >
                    {OBSTACLE_CATALOG.map((ob) => (
                      <option key={ob.kind} value={ob.kind}>
                        {ob.title}
                      </option>
                    ))}
                  </select>
                </label>

                <TextField
                  label="ПОДПИСЬ"
                  value={selectedObstacle.label ?? ""}
                  onChange={(v) =>
                    patchDef({
                      obstacles: def.obstacles.map((o) => (o.id === selectedObstacle.id ? { ...o, label: v } : o)),
                    })
                  }
                />

                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X, М"
                    value={selectedObstacle.cx}
                    onChange={(v) =>
                      patchDef({
                        obstacles: def.obstacles.map((o) => (o.id === selectedObstacle.id ? { ...o, cx: v } : o)),
                      })
                    }
                  />
                  <NumField
                    label="Z, М"
                    value={selectedObstacle.cz}
                    onChange={(v) =>
                      patchDef({
                        obstacles: def.obstacles.map((o) => (o.id === selectedObstacle.id ? { ...o, cz: v } : o)),
                      })
                    }
                  />
                  <NumField
                    label="УГОЛ, °"
                    value={radToDeg(selectedObstacle.h)}
                    step={5}
                    min={-180}
                    max={180}
                    onChange={(v) =>
                      patchDef({
                        obstacles: def.obstacles.map((o) =>
                          o.id === selectedObstacle.id ? { ...o, h: degToRad(v) } : o
                        ),
                      })
                    }
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="ПОЛУШИР. X"
                    value={selectedObstacle.halfX}
                    min={0.08}
                    max={120}
                    onChange={(v) =>
                      patchDef({
                        obstacles: def.obstacles.map((o) => (o.id === selectedObstacle.id ? { ...o, halfX: v } : o)),
                      })
                    }
                  />
                  <NumField
                    label="ПОЛУДЛИНА Z"
                    value={selectedObstacle.halfZ}
                    min={0.08}
                    max={120}
                    onChange={(v) =>
                      patchDef({
                        obstacles: def.obstacles.map((o) => (o.id === selectedObstacle.id ? { ...o, halfZ: v } : o)),
                      })
                    }
                  />
                  <NumField
                    label="ВЫСОТА, М"
                    value={selectedObstacle.height}
                    min={0.1}
                    max={48}
                    onChange={(v) =>
                      patchDef({
                        obstacles: def.obstacles.map((o) => (o.id === selectedObstacle.id ? { ...o, height: v } : o)),
                      })
                    }
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 text-xs">
                    <span className="mono text-[10px] text-[#7c909d]">ЦВЕТ 3D:</span>
                    <input
                      type="color"
                      value={hexFromNum(selectedObstacle.color, getObstacleSpec(selectedObstacle.kind).color)}
                      onChange={(e) =>
                        patchDef({
                          obstacles: def.obstacles.map((o) =>
                            o.id === selectedObstacle.id ? { ...o, color: numFromHex(e.target.value) } : o
                          ),
                        })
                      }
                      className="h-6 w-10 rounded bg-transparent border hairline cursor-pointer"
                    />
                  </label>
                  {selectedObstacle.kind === "parked_car" && (
                    <select
                      value={selectedObstacle.model ?? "rio"}
                      onChange={(e) => {
                        const m = e.target.value as ParkedModelKey;
                        const dim = VEHICLE_DIMS[m];
                        patchDef({
                          obstacles: def.obstacles.map((o) =>
                            o.id === selectedObstacle.id
                              ? {
                                  ...o,
                                  model: m,
                                  halfX: Number((dim.width / 2).toFixed(2)),
                                  halfZ: Number((dim.length / 2).toFixed(2)),
                                  height: dim.height,
                                }
                              : o
                          ),
                        });
                      }}
                      className="rounded-lg bg-[#091017] border hairline px-2 py-1 text-xs text-white"
                    >
                      {PARKED_MODELS.map((m) => (
                        <option key={m} value={m}>
                          {VEHICLE_DIMS[m].name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            {/* Инспектор: Контрольная точка маршрута (КТ) */}
            {selectedCp && (
              <div className="space-y-2.5">
                <TextField
                  label="ЗАДАНИЕ ЭКЗАМЕНАТОРА"
                  value={selectedCp.instruction}
                  onChange={(v) =>
                    patchDef({
                      checkpoints: def.checkpoints.map((c) => (c.id === selectedCp.id ? { ...c, instruction: v } : c)),
                    })
                  }
                />
                <div className="grid grid-cols-3 gap-2">
                  <NumField
                    label="X, М"
                    value={selectedCp.x}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({
                        checkpoints: def.checkpoints.map((c) => (c.id === selectedCp.id ? { ...c, x: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="Z, М"
                    value={selectedCp.z}
                    step={0.5}
                    onChange={(v) =>
                      patchDef({
                        checkpoints: def.checkpoints.map((c) => (c.id === selectedCp.id ? { ...c, z: v } : c)),
                      })
                    }
                  />
                  <NumField
                    label="РАДИУС, М"
                    value={selectedCp.radius}
                    step={0.5}
                    min={1}
                    max={25}
                    onChange={(v) =>
                      patchDef({
                        checkpoints: def.checkpoints.map((c) => (c.id === selectedCp.id ? { ...c, radius: v } : c)),
                      })
                    }
                  />
                </div>
                {def.checkpoints.length > 1 && (() => {
                  const cpIdx = def.checkpoints.findIndex((c) => c.id === selectedCp.id);
                  const swapCp = (dir: -1 | 1) => {
                    const target = cpIdx + dir;
                    if (target < 0 || target >= def.checkpoints.length) return;
                    const arr = [...def.checkpoints];
                    [arr[cpIdx], arr[target]] = [arr[target], arr[cpIdx]];
                    patchDef({ checkpoints: arr });
                  };
                  return (
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="mono text-[10px] text-[#7c909d]">
                        ПОРЯДОК В МАРШРУТЕ: #{cpIdx + 1} ИЗ {def.checkpoints.length}
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="btn btn-mini"
                          disabled={cpIdx <= 0}
                          onClick={() => swapCp(-1)}
                          title="Переместить КТ раньше по маршруту"
                        >
                          ↑ Раньше
                        </button>
                        <button
                          type="button"
                          className="btn btn-mini"
                          disabled={cpIdx >= def.checkpoints.length - 1}
                          onClick={() => swapCp(1)}
                          title="Переместить КТ позже по маршруту"
                        >
                          ↓ Позже
                        </button>
                      </div>
                    </div>
                  );
                })()}
                <label className="block">
                  <span className="mono text-[10px] text-[#7c909d] block mb-1">ТРЕБУЕМЫЙ ПОВОРОТНИК</span>
                  <select
                    value={selectedCp.requireSignal ?? ""}
                    onChange={(e) =>
                      patchDef({
                        checkpoints: def.checkpoints.map((c) =>
                          c.id === selectedCp.id
                            ? {
                                ...c,
                                requireSignal:
                                  e.target.value === "left" || e.target.value === "right" ? e.target.value : undefined,
                              }
                            : c
                        ),
                      })
                    }
                    className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
                  >
                    <option value="">Не требуется</option>
                    <option value="left">Левый поворотник (Q)</option>
                    <option value="right">Правый поворотник (E)</option>
                  </select>
                </label>
                <div className="flex flex-col gap-1.5 pt-1">
                  <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedCp.requireStop)}
                      onChange={(e) =>
                        patchDef({
                          checkpoints: def.checkpoints.map((c) =>
                            c.id === selectedCp.id ? { ...c, requireStop: e.target.checked || undefined } : c
                          ),
                        })
                      }
                      className="accent-[#f5b942]"
                    />
                    <span>Обязательная остановка в зоне КТ (знак STOP)</span>
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedCp.isFinalPark)}
                      onChange={(e) =>
                        patchDef({
                          checkpoints: def.checkpoints.map((c) =>
                            c.id === selectedCp.id ? { ...c, isFinalPark: e.target.checked || undefined } : c
                          ),
                        })
                      }
                      className="accent-[#52d6bd]"
                    />
                    <span>Финишная парковка в свободном боксе</span>
                  </label>
                </div>
              </div>
            )}
            </>
            )}
          </div>
          )}

          {/* Реестр всех объектов на карте с быстрым переходом */}
          {!editorClosed.objects && (
          <div className="panel p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold">Объекты на карте ({totalObjects})</span>
              <div className="flex items-center gap-1">
                {roads.length > 0 && !editorCollapsed.objects && (
                  <button type="button" className="btn btn-mini" onClick={() => handleAutoRoute()}>
                    Автомаршрут
                  </button>
                )}
                <button
                  type="button"
                  aria-label={editorCollapsed.objects ? "Развернуть список объектов" : "Свернуть список объектов"}
                  title={editorCollapsed.objects ? "Развернуть" : "Свернуть"}
                  onClick={() => toggleEditorCollapse("objects")}
                  className="mono h-6 w-6 rounded-md border hairline text-xs text-[#9bafbc] hover:text-[#f5b942]"
                >
                  {editorCollapsed.objects ? "+" : "−"}
                </button>
                <button
                  type="button"
                  aria-label="Закрыть список объектов"
                  title="Закрыть список объектов (вернуть — «+ Объекты»)"
                  onClick={() => closeEditorCard("objects")}
                  className="mono h-6 w-6 rounded-md border hairline text-xs text-[#9bafbc] hover:text-[#ff8080]"
                >
                  ×
                </button>
              </div>
            </div>

            {!editorCollapsed.objects && (
            <>

            <div className="flex flex-wrap gap-1">
              {([
                ["all", `Все (${totalObjects})`],
                ["signs", `Знаки (${signs.length})`],
                ["signals", `Светоф. (${signals.length})`],
                ["crosswalks", `Зебры (${crosswalks.length})`],
                ["roads", `Дороги (${roads.length})`],
                ["bays", `Боксы (${def.bays.length})`],
                ["obstacles", `Объекты (${def.obstacles.length})`],
                ["checkpoints", `КТ (${def.checkpoints.length})`],
              ] as Array<[ListFilter, string]>).map(([f, lbl]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setListFilter(f)}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer border ${
                    listFilter === f
                      ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-[#f5b942]"
                      : "bg-[#091017] border-white/10 text-[#8fa2ae]"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>

            <div className="max-h-[250px] overflow-y-auto scroll-thin space-y-1 pr-0.5">
              {(listFilter === "all" || listFilter === "signs") &&
                signs.map((sn) => {
                  const active = primary?.kind === "sign" && primary.id === sn.id;
                  return (
                    <button
                      key={sn.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "sign", id: sn.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">
                        <strong className="text-[#f5b942] mr-1.5">[{formatSignBadge(sn)}]</strong>
                        {sn.label || getRoadSignSpec(sn.kind).title}
                      </span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">
                        {sn.x.toFixed(0)}, {sn.z.toFixed(0)}
                      </span>
                    </button>
                  );
                })}

              {(listFilter === "all" || listFilter === "signals") &&
                signals.map((sg) => {
                  const active = primary?.kind === "signal" && primary.id === sg.id;
                  return (
                    <button
                      key={sg.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "signal", id: sg.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">Светофор {sg.id} ({sg.greenDuration}/{sg.redDuration} с)</span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">
                        {sg.x.toFixed(0)}, {sg.z.toFixed(0)}
                      </span>
                    </button>
                  );
                })}

              {(listFilter === "all" || listFilter === "crosswalks") &&
                crosswalks.map((cw) => {
                  const active = primary?.kind === "crosswalk" && primary.id === cw.id;
                  return (
                    <button
                      key={cw.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "crosswalk", id: cw.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">Переход {cw.id} ({cw.width}×{cw.length} м)</span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">
                        {cw.cx.toFixed(0)}, {cw.cz.toFixed(0)}
                      </span>
                    </button>
                  );
                })}

              {(listFilter === "all" || listFilter === "roads") &&
                roads.map((r) => {
                  const active = primary?.kind === "road" && primary.id === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "road", id: r.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">Дорога: {r.name || r.id} ({r.lanes} п., {r.width} м)</span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">{r.points.length} узл.</span>
                    </button>
                  );
                })}

              {(listFilter === "all" || listFilter === "bays") &&
                def.bays.map((b) => {
                  const active = primary?.kind === "bay" && primary.id === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "bay", id: b.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">
                        {b.label} {b.occupied ? "(занят)" : "(свободен)"}
                      </span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">
                        {b.width}×{b.length}
                      </span>
                    </button>
                  );
                })}

              {(listFilter === "all" || listFilter === "checkpoints") &&
                def.checkpoints.map((c, idx) => {
                  const active = primary?.kind === "checkpoint" && primary.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "checkpoint", id: c.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">
                        КТ #{idx + 1}: {c.instruction}
                      </span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">r={c.radius}</span>
                    </button>
                  );
                })}

              {(listFilter === "all" || listFilter === "obstacles") &&
                def.obstacles.slice(0, 120).map((o) => {
                  const active = primary?.kind === "obstacle" && primary.id === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setSelection({ kind: "obstacle", id: o.id });
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] cursor-pointer border ${
                        active ? "bg-[#f5b942]/15 border-[#f5b942]/50 text-white" : "bg-[#091017] border-white/5 text-[#c3d2dc]"
                      }`}
                    >
                      <span className="truncate">
                        {getObstacleSpec(o.kind).title}: {o.label || o.id}
                      </span>
                      <span className="mono text-[10px] text-[#7c909d] shrink-0">
                        {o.cx.toFixed(0)}, {o.cz.toFixed(0)}
                      </span>
                    </button>
                  );
                })}

              {totalObjects === 0 && (
                <div className="text-[11px] text-[#7c909d] py-3 text-center">
                  На карте пока только стартовая позиция — выберите класс сверху и кликните по 2D-карте.
                </div>
              )}
            </div>
            </>
            )}
          </div>
          )}

          {/* Общие параметры сценария, площадки и произвольных границ мира */}
          {!editorClosed.bounds && (
          <div className="panel p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="text-xs font-extrabold">Площадка и границы мира</span>
              <div className="flex flex-wrap items-center gap-1">
                {!editorCollapsed.bounds && (
                <>
                <button
                  type="button"
                  className="btn btn-mini text-[#f5b942]"
                  onClick={() => setTool("boundary")}
                  title="Нарисовать произвольную форму площадки или выбрать шаблон (Г/Т/П-образная, трапеция, 8-угольник)"
                >
                  ⬠ Своя форма
                </button>
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => handlePresetBoundary("l_shape")}
                  title="Сделать площадку Г-образной (вогнутый 6-угольник)"
                >
                  Г-обр.
                </button>
                <button
                  type="button"
                  className="btn btn-mini"
                  disabled={roads.length === 0 && def.checkpoints.length < 2}
                  onClick={() => handleCorridorBoundary(false)}
                  title="Задать границу коридором вдоль маршрута"
                >
                  Коридор
                </button>
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={def.boundaryPolygon ? handleResetBoundaryToRect : handleFitBounds}
                >
                  {def.boundaryPolygon ? "В прямоуг." : "Подогнать"}
                </button>
                </>
                )}
                <button
                  type="button"
                  aria-label={editorCollapsed.bounds ? "Развернуть параметры площадки" : "Свернуть параметры площадки"}
                  title={editorCollapsed.bounds ? "Развернуть" : "Свернуть"}
                  onClick={() => toggleEditorCollapse("bounds")}
                  className="mono h-6 w-6 rounded-md border hairline text-xs text-[#9bafbc] hover:text-[#f5b942]"
                >
                  {editorCollapsed.bounds ? "+" : "−"}
                </button>
                <button
                  type="button"
                  aria-label="Закрыть параметры площадки"
                  title="Закрыть блок (вернуть — «+ Площадка и границы»)"
                  onClick={() => closeEditorCard("bounds")}
                  className="mono h-6 w-6 rounded-md border hairline text-xs text-[#9bafbc] hover:text-[#ff8080]"
                >
                  ×
                </button>
              </div>
            </div>

            {!editorCollapsed.bounds && (
            <>
            {def.boundaryPolygon && def.boundaryPolygon.length >= 3 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#091017] border border-[#f5b942]/30 px-2.5 py-1.5 text-[11px]">
                <span className="text-[#f5d78a]">
                  ⬠ Произвольная площадка: <b>{def.boundaryPolygon.length}</b> вершин · S ≈{" "}
                  <b>{Math.round(polygonArea(def.boundaryPolygon))}</b> м² (
                  {Math.round(def.bounds.maxX - def.bounds.minX)}×{Math.round(def.bounds.maxZ - def.bounds.minZ)} м)
                </span>
                <button type="button" className="btn btn-mini text-[#52d6bd]" onClick={handleCropToBoundary}>
                  ✂ Обрезать
                </button>
              </div>
            )}
            <div className="grid sm:grid-cols-2 gap-2">
              <TextField label="НАЗВАНИЕ" value={def.title} onChange={(v) => patchDef({ title: v })} />
              <TextField label="ПОДЗАГОЛОВОК" value={def.subtitle} onChange={(v) => patchDef({ subtitle: v })} />
            </div>
            <label className="block">
              <span className="mono text-[10px] text-[#7c909d] block mb-1">ЗАДАНИЕ ЭКЗАМЕНАТОРА</span>
              <textarea
                value={def.brief}
                onChange={(e) => patchDef({ brief: e.target.value })}
                rows={2}
                className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white resize-y"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1.5">
                <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={def.useLotSurface !== false}
                    onChange={(e) => patchDef({ useLotSurface: e.target.checked })}
                    className="accent-[#f5b942]"
                  />
                  <span>
                    {def.boundaryPolygon ? "Асфальт по форме контура" : "Асфальтовая площадка автодрома"}
                  </span>
                </label>
                <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(def.perimeterCurb)}
                    onChange={(e) => patchDef({ perimeterCurb: e.target.checked || undefined })}
                    className="accent-[#f5b942]"
                  />
                  <span>3D-бордюр по контуру площадки</span>
                </label>
              </div>
              <div className="w-28">
                <NumField
                  label="БАЗОВЫЙ КМ/Ч"
                  value={def.defaultSpeedLimitKmh}
                  min={5}
                  max={110}
                  step={5}
                  onChange={(v) => patchDef({ defaultSpeedLimitKmh: v })}
                />
              </div>
            </div>
            {def.useLotSurface !== false && !def.boundaryPolygon && (
              <div className="grid grid-cols-2 gap-2">
                <NumField
                  label="ПЛОЩАДКА ±X, М"
                  value={def.lotHalfX}
                  min={5}
                  max={400}
                  step={1}
                  onChange={(v) => patchDef({ lotHalfX: v })}
                />
                <NumField
                  label="ПЛОЩАДКА ±Z, М"
                  value={def.lotHalfZ}
                  min={5}
                  max={400}
                  step={1}
                  onChange={(v) => patchDef({ lotHalfZ: v })}
                />
              </div>
            )}
            <div className="grid grid-cols-4 gap-2">
              <NumField
                label="MIN X"
                value={def.bounds.minX}
                step={2}
                onChange={(v) => patchDef({ boundaryPolygon: undefined, bounds: { ...def.bounds, minX: v } })}
              />
              <NumField
                label="MAX X"
                value={def.bounds.maxX}
                step={2}
                onChange={(v) => patchDef({ boundaryPolygon: undefined, bounds: { ...def.bounds, maxX: v } })}
              />
              <NumField
                label="MIN Z"
                value={def.bounds.minZ}
                step={2}
                onChange={(v) => patchDef({ boundaryPolygon: undefined, bounds: { ...def.bounds, minZ: v } })}
              />
              <NumField
                label="MAX Z"
                value={def.bounds.maxZ}
                step={2}
                onChange={(v) => patchDef({ boundaryPolygon: undefined, bounds: { ...def.bounds, maxZ: v } })}
              />
            </div>
            </>
            )}
          </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function selectedSignSel(id: string): EditorSelection {
  return { kind: "sign", id };
}
