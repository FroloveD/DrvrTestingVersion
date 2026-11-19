/**
 * @module components/CustomScenarioView
 * @layer ui
 * @role Редактор карт и сценариев: офлайн-импорт OSM (.osm XML / Overpass JSON / GeoJSON), палитра знаков и объектов, 2D drag-and-drop, инспектор и Undo/Redo.
 * @invariants #1 (координаты и курс h), #8–#9 (офлайн-импорт + атрибуция ODbL 1.0), #15 (снимок мира в попытке), #16 (без неподписанных штрафов).
 * @tests T16, T27, T28, T29; смоук A, G, O (`tests/browser-smoke.mjs`)
 *
 * Оглавление секций (`grep -n "SEC:custom-"`):
 * - `[SEC:custom-fields]`  — числовые/текстовые поля ввода и справочники редактора (`NumField`, `TextField`).
 * - `[SEC:custom-preview]` — палитра классов, сетка/слои, Undo/Redo и интерактивный 2D-холст (`MapCanvasEditor`).
 * - `[SEC:custom-forms]`   — инспектор выбранного объекта, реестр объектов, параметры карты и памятка импорта OSM.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOUNDARY_SHAPE_PRESETS, polygonArea, type BoundaryShapePreset } from "../maps/boundary";
import {
  buildCityOsmScenario,
  buildParallelScenario,
  buildPerpendicularScenario,
} from "../scenarios/catalog";
import {
  customFromWorld,
  defaultCustomScenario,
  emptyCustomScenario,
  importEditorFileText,
  validateCustomScenario,
  type CustomScenarioDef,
} from "../scenarios/custom";
import {
  appendRoadPoint,
  applyPresetBoundaryShape,
  clearBoundaryPolygon,
  setCustomBoundaryPolygon,
  attachCheckpointToSign,
  createEditorHistory,
  deleteSelected,
  duplicateSelected,
  fitBoundsToContent,
  getSelectionAnchor,
  primarySelection,
  pushEditorHistory,
  rebuildRouteFromEditorRoads,
  redoEditorHistory,
  rotateSelected,
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
import { VEHICLE_DIMS } from "../sim/vehicle";
import { Chip, downloadJson, Icon } from "./Icons";
import { DEFAULT_LAYERS, MapCanvasEditor, type LayerVisibility } from "./MapCanvasEditor";

type Props = {
  def: CustomScenarioDef;
  onChange: (next: CustomScenarioDef) => void;
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
  return (
    <label className="block min-w-0">
      <span className="mono text-[10px] text-[#7c909d] block mb-1">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
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
  { v: 0, l: "Выкл", hint: "Скрыть сетку и отключить привязку — свободное перемещение объектов" },
  { v: 0.5, l: "0,5 м", hint: "Мелкая сетка для точной расстановки конусов, стоек и дорожных знаков" },
  { v: 1, l: "1 м", hint: "Сетка для выравнивания парковочных боксов, бордюров и стоп-линий" },
  { v: 2, l: "2 м", hint: "Сетка для разметки полос, переходов и углов площадки" },
  { v: 5, l: "5 м", hint: "Крупная сетка для улиц, зданий и контура карты" },
];

const LAYER_LABELS: Array<{ k: keyof LayerVisibility; l: string }> = [
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

export function CustomScenarioView({ def, onChange, calibration, onOpenInSimulator, onNotify }: Props) {
  const importRef = useRef<HTMLInputElement | null>(null);
  const [tool, setTool] = useState<EditorTool>("select");
  const [selection, setSelection] = useState<EditorSelection | null>({ kind: "start" });
  const [snapStep, setSnapStep] = useState<number>(0.5);
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const [fitSignal, setFitSignal] = useState<number>(0);
  const [draftBoundary, setDraftBoundary] = useState<Vec2[]>([]);

  // Параметры добавляемого объекта в палитре
  const [signKind, setSignKind] = useState<RoadSignKind>("speed_limit");
  const [signSpeedLimit, setSignSpeedLimit] = useState<number>(40);
  const [obstacleKind, setObstacleKind] = useState<ObstacleKind>("cone");
  const [parkedModel, setParkedModel] = useState<ParkedModelKey>("rio");
  const [bayKind, setBayKind] = useState<ParkingBayKind>("perpendicular");
  const [placeHeadingDeg, setPlaceHeadingDeg] = useState<number>(0);
  const [roadWidth, setRoadWidth] = useState<number>(7.5);
  const [roundRoadCorners, setRoundRoadCorners] = useState<boolean>(false);
  const [roadCornerRadius, setRoadCornerRadius] = useState<number>(8);

  // История отмен и фильтр реестра объектов
  const [history, setHistory] = useState(() => createEditorHistory<CustomScenarioDef>());
  const [listFilter, setListFilter] = useState<ListFilter>("all");
  const [showOsmHelp, setShowOsmHelp] = useState(false);

  const validation = useMemo(() => validateCustomScenario(def), [def]);
  const blocked = validation.errors.length > 0;

  const commitChange = useCallback(
    (next: CustomScenarioDef, before: CustomScenarioDef = def) => {
      if (next === before) return;
      setHistory((h) => pushEditorHistory(h, before));
      onChange(next);
    },
    [def, onChange]
  );

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

  // Горячие клавиши редактора (не перехватываются при вводе текста в поля)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((mod && e.code === "KeyY") || (mod && e.shiftKey && e.code === "KeyZ")) {
        e.preventDefault();
        handleRedo();
      } else if (mod && e.code === "KeyD") {
        e.preventDefault();
        handleDuplicate();
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (selection && selection.kind !== "start") {
          e.preventDefault();
          handleDelete();
        }
      } else if (tool === "boundary" && e.code === "Enter" && draftBoundary.length >= 3) {
        e.preventDefault(); handleFinishBoundary(draftBoundary);
      } else if (tool === "boundary" && e.code === "Escape") {
        e.preventDefault(); handleCancelBoundary();
      } else if (e.code === "Escape") {
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draftBoundary, handleCancelBoundary, handleDelete, handleDuplicate, handleFinishBoundary, handleRedo, handleUndo, selection, tool]);

  const applyImportedScenario = (next: CustomScenarioDef, message: string) => {
    commitChange(next, def);
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
      const { def: imported, summary } = importEditorFileText(text, file.name);
      applyImportedScenario(imported, summary);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось импортировать файл карты");
    }
  };

  const handleImportInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await readAndImportFile(file);
  };

  const handleAutoRoute = () => {
    const res = rebuildRouteFromEditorRoads(def);
    if (res.count === 0) {
      onNotify("Для автомаршрута нужна дорога длиной не менее ~30 м");
      return;
    }
    commitChange(res.def, def);
    setSelection({ kind: "start" });
    onNotify(`Построен маршрут (${res.count} КТ)${res.roadName ? ` по «${res.roadName}»` : ""}`);
  };

  const handleFinishBoundary = useCallback((points: Vec2[]) => {
    const result = setCustomBoundaryPolygon(def, points);
    if (!result.ok) { onNotify(result.error ?? "Не удалось применить контур"); return; }
    commitChange(result.def, def);
    setDraftBoundary([]); setTool("select"); setSelection({ kind: "boundary_point", index: 0 });
    setFitSignal((n) => n + 1);
    onNotify(`Задан контур площадки: ${result.def.boundaryPolygon?.length ?? 0} вершин, ${Math.round(polygonArea(result.def.boundaryPolygon ?? []))} м²`);
  }, [commitChange, def, onNotify]);

  const handlePresetBoundary = (preset: BoundaryShapePreset) => {
    const result = applyPresetBoundaryShape(def, preset);
    commitChange(result.def, def); setTool("boundary"); setSelection({ kind: "boundary_point", index: 0 });
    setDraftBoundary([]); setFitSignal((n) => n + 1);
    onNotify(`Форма площадки применена: ${result.vertices} вершин. Перетаскивай вершины для настройки.`);
  };
  const handleResetBoundary = () => {
    commitChange(clearBoundaryPolygon(def), def); setSelection({ kind: "start" }); setDraftBoundary([]);
    setFitSignal((n) => n + 1); onNotify("Произвольный контур сброшен");
  };
  const handleCancelBoundary = () => { setDraftBoundary([]); setTool("select"); };

  const handleFitBounds = () => {
    const fitted = fitBoundsToContent(def, 12);
    commitChange(fitted, def);
    setFitSignal((n) => n + 1);
    onNotify("Границы мира подогнаны по объектам карты");
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
      roadWidth,
      cornerRadiusM: roundRoadCorners ? roadCornerRadius : 0,
    }),
    [bayKind, calibration, obstacleKind, parkedModel, placeHeadingDeg, roadWidth, roundRoadCorners, roadCornerRadius, signKind, signSpeedLimit, snapStep]
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
            {roads.length > 0 && (
              <button type="button" className="btn btn-mini" onClick={handleAutoRoute}>
                <Icon name="route" size={12} /> Автомаршрут
              </button>
            )}
            <button type="button" className="btn btn-mini" onClick={handleFitBounds}>
              Подогнать границы
            </button>
          </div>
        </div>
      )}

      {/* Ошибки и предупреждения проверки геометрии */}
      {(blocked || validation.warnings.length > 0) && (
        <div className="panel p-3.5 space-y-1">
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
        </div>
      )}

      {/* === [SEC:custom-preview] Палитра классов, действия Undo/Redo и интерактивный 2D-холст === */}
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
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[#091017] border hairline px-3 py-2">
            <label className="flex items-center gap-2 text-[11px] text-[#c3d2dc]">
              <span>Ширина новой дороги, м</span>
              <input aria-label="Ширина новой дороги" type="number" min="1.5" max="60" step="0.25" value={roadWidth} onChange={(e) => setRoadWidth(Math.max(1.5, Math.min(60, Number(e.target.value) || 1.5)))} className="w-20 rounded bg-[#111c26] border hairline px-2 py-1 text-white" />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-[#c3d2dc]">
              <input type="checkbox" checked={roundRoadCorners} onChange={(e) => setRoundRoadCorners(e.target.checked)} className="accent-[#f5b942]" />
              Скруглять углы
            </label>
            {roundRoadCorners && <label className="flex items-center gap-2 text-[11px] text-[#c3d2dc]">
              <span>Радиус, м</span><input aria-label="Радиус скругления дороги" type="number" min="1" max="40" step="0.5" value={roadCornerRadius} onChange={(e) => setRoadCornerRadius(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} className="w-16 rounded bg-[#111c26] border hairline px-2 py-1 text-white" />
            </label>}
            <span className="text-[10px] text-[#7c909d]">Для инструмента «Дорога» · ширина 1,5–60 м</span>
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
          </div>
        </div>

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
              title="Метрическая сетка на карте и шаг привязки координат/углов. «Выкл» скрывает сетку и включает свободное перемещение."
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
              onClick={() => applyImportedScenario(defaultCustomScenario(), "Восстановлен стартовый шаблон площадки")}
            >
              Площадка
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                applyImportedScenario(
                  customFromWorld(buildPerpendicularScenario(calibration), "Мой бокс 90°"),
                  "Шаблон: копия «Бокс 90°»"
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
                  "Шаблон: копия «Параллельная»"
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
                  "Шаблон: копия «Город OSM» со светофорами, знаком 40 и переходом"
                )
              }
            >
              Город OSM
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => applyImportedScenario(emptyCustomScenario(), "Создана чистая учебная карта")}
            >
              Пустая
            </button>
          </div>
        </div>
      </div>

      {/* Основная рабочая область: слева 2D-холст, справа инспектор выбранного объекта */}
      <div className="grid xl:grid-cols-[1fr_410px] gap-4 items-start">
        <MapCanvasEditor
          def={def}
          tool={tool}
          selection={selection}
          snapStep={snapStep}
          layers={layers}
          placeOptions={placeOptions}
          fitSignal={fitSignal}
          onSelect={setSelection}
          onLiveChange={onChange}
          onCommitChange={commitChange}
          draftBoundary={draftBoundary}
          onDraftBoundaryChange={setDraftBoundary}
          onFinishBoundary={handleFinishBoundary}
          onCancelBoundary={handleCancelBoundary}
        />

        {/* === [SEC:custom-forms] Инспектор выбранного объекта, реестр и параметры карты === */}
        <div className="space-y-4 min-w-0">
          {/* Инспектор свойств выбранного объекта */}
          <div className="panel p-4 space-y-3" data-testid="editor-inspector">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="mono text-[10px] text-[#7c909d]">ИНСПЕКТОР ОБЪЕКТА</div>
                <div className="text-sm font-extrabold text-white">
                  {selectedAnchor ? selectedAnchor.label : "Объект не выбран"}
                </div>
              </div>
              {selectedAnchor && selectedAnchor.h !== null && (
                <div className="flex items-center gap-1" title="Быстрый поворот объекта">
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
                </div>
              )}
            </div>

            {!primary && (
              <p className="text-[12px] text-[#8fa2ae] leading-relaxed">
                Кликните по любому объекту на 2D-карте (или в реестре ниже), чтобы перетащить его мышью, повернуть или
                изменить точные размеры и параметры. Для добавления выберите класс в палитре сверху.
              </p>
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
                                zoneLength: isSpeedSignKind(nextKind)
                                  ? s.zoneLength ?? s.zoneRadius ?? spec.defaultZoneLength ?? 250
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
                        label="ДЛИНА УЧАСТКА, М"
                        value={selectedSign.zoneLength ?? selectedSign.zoneRadius ?? 250}
                        step={5}
                        min={0}
                        max={2000}
                        onChange={(v) =>
                          patchDef({
                            signs: signs.map((s) => (s.id === selectedSign.id ? { ...s, zoneLength: v } : s)),
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
                    step={0.25}
                    min={1.5}
                    max={60}
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
                <div className="grid grid-cols-2 gap-2">
                  <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={(selectedRoad.cornerRadiusM ?? 0) > 0}
                      onChange={(e) => patchDef({ roads: roads.map((r) => r.id === selectedRoad.id ? { ...r, cornerRadiusM: e.target.checked ? 8 : 0 } : r) })} className="accent-[#f5b942]" />
                    <span>Скруглять углы</span>
                  </label>
                  {(selectedRoad.cornerRadiusM ?? 0) > 0 && <NumField label="РАДИУС, М" value={selectedRoad.cornerRadiusM ?? 8} min={1} max={40} step={0.5}
                    onChange={(v) => patchDef({ roads: roads.map((r) => r.id === selectedRoad.id ? { ...r, cornerRadiusM: v } : r) })} />}
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
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="mono text-[10px] text-[#7c909d]">
                    УЗЛОВ: {selectedRoad.points.length} · радиус {selectedRoad.cornerRadiusM ?? 0} м (перетаскивайте кружки)
                  </span>
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
                    max={18}
                    onChange={(v) =>
                      patchDef({
                        checkpoints: def.checkpoints.map((c) => (c.id === selectedCp.id ? { ...c, radius: v } : c)),
                      })
                    }
                  />
                </div>
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
          </div>

          {/* Реестр всех объектов на карте с быстрым переходом */}
          <div className="panel p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold">Объекты на карте ({totalObjects})</span>
              {roads.length > 0 && (
                <button type="button" className="btn btn-mini" onClick={handleAutoRoute}>
                  Автомаршрут
                </button>
              )}
            </div>

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
          </div>

          {/* Общие параметры сценария, площадки и границ мира */}
          <div className="panel p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold">Параметры карты и границы</span>
              <button type="button" className="btn btn-mini" onClick={handleFitBounds}>
                Подогнать границы
              </button>
            </div>
            <div className="rounded-lg border border-[#f5b942]/25 bg-[#091017] p-2 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="mono text-[10px] text-[#f5d78a]">ФОРМА ПЛОЩАДКИ / ГРАНИЦА МИРА</span><span className="mono text-[10px] text-[#9bafbc]">{def.boundaryPolygon ? `${def.boundaryPolygon.length} вершин · ${Math.round(polygonArea(def.boundaryPolygon))} м²` : "прямоугольные границы"}</span></div>
              <div className="flex flex-wrap gap-1">{BOUNDARY_SHAPE_PRESETS.map(p => <button key={p.id} type="button" className="btn btn-mini" title={p.hint} onClick={() => handlePresetBoundary(p.id)}>{p.label}</button>)}</div>
              <div className="flex flex-wrap items-center gap-2 text-xs"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={Boolean(def.perimeterCurb)} onChange={e => patchDef({ perimeterCurb: e.target.checked || undefined })} className="accent-[#f5b942]" />3D-бордюр по контуру</label><button type="button" className="btn btn-mini" onClick={() => { setTool("boundary"); setDraftBoundary([]); }}>Нарисовать контур</button>{def.boundaryPolygon && <button type="button" className="btn btn-mini text-[#ff9494]" onClick={handleResetBoundary}>Сбросить контур</button>}</div>
              {tool === "boundary" && <div className="text-[10px] text-[#9bafbc]">Кликайте по карте, чтобы добавить вершины. Двойной клик или клик рядом с первой точкой замыкает контур. Enter — применить, Esc — отменить.</div>}
              {draftBoundary.length > 0 && <div className="flex items-center justify-between text-[11px]"><span>Черновик: {draftBoundary.length} точек</span><div className="flex gap-1"><button type="button" className="btn btn-mini" onClick={() => setDraftBoundary(v => v.slice(0,-1))}>Назад</button><button type="button" className="btn btn-mini" disabled={draftBoundary.length < 3} onClick={() => handleFinishBoundary(draftBoundary)}>Применить</button><button type="button" className="btn btn-mini" onClick={handleCancelBoundary}>Отмена</button></div></div>}
            </div>
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
              <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="editor-lot-surface-toggle"
                  aria-label="Стартовая асфальтовая площадка"
                  checked={def.useLotSurface !== false}
                  onChange={(e) => patchDef({ useLotSurface: e.target.checked })}
                  className="accent-[#f5b942]"
                />
                <span>Стартовая асфальтовая площадка</span>
              </label>
              <div className="w-full text-[10px] text-[#7c909d]">
                Снимите флажок, чтобы убрать покрытие. В режиме «Выбор» перетащите площадку для перемещения, угловые ручки — для изменения размеров.
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
            {def.useLotSurface !== false && (
              <div className="grid grid-cols-2 gap-2">
                <NumField
                  label="ПЛОЩАДКА ±X, М"
                  value={def.lotHalfX}
                  min={5}
                  max={200}
                  step={1}
                  onChange={(v) => patchDef({ lotHalfX: v })}
                />
                <NumField
                  label="ПЛОЩАДКА ±Z, М"
                  value={def.lotHalfZ}
                  min={5}
                  max={200}
                  step={1}
                  onChange={(v) => patchDef({ lotHalfZ: v })}
                />
                <NumField label="ЦЕНТР X, М" value={def.lotCenterX ?? 0} step={0.5} onChange={(v) => patchDef({ lotCenterX: v })} />
                <NumField label="ЦЕНТР Z, М" value={def.lotCenterZ ?? 0} step={0.5} onChange={(v) => patchDef({ lotCenterZ: v })} />
              </div>
            )}
            <div className="grid grid-cols-4 gap-2">
              <NumField
                label="MIN X"
                value={def.bounds.minX}
                step={2}
                onChange={(v) => patchDef({ bounds: { ...def.bounds, minX: v } })}
              />
              <NumField
                label="MAX X"
                value={def.bounds.maxX}
                step={2}
                onChange={(v) => patchDef({ bounds: { ...def.bounds, maxX: v } })}
              />
              <NumField
                label="MIN Z"
                value={def.bounds.minZ}
                step={2}
                onChange={(v) => patchDef({ bounds: { ...def.bounds, minZ: v } })}
              />
              <NumField
                label="MAX Z"
                value={def.bounds.maxZ}
                step={2}
                onChange={(v) => patchDef({ bounds: { ...def.bounds, maxZ: v } })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function selectedSignSel(id: string): EditorSelection {
  return { kind: "sign", id };
}
