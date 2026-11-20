/**
 * @module components/SimulatorView
 * @layer ui
 * @role Главный экран 3D-тренажёра: цикл 1/60 с, опрос ввода, запись заезда, зеркала и перемещаемые панели HUD.
 * @invariants #2–#6, #9–#15 (холодный старт, АКПП, квантование до шага, мышь, зеркала, HUD, раздельные педали, closed).
 * @tests Смоук A, E, F, G, H, J, K, L, M (`tests/browser-smoke.mjs`)
 *
 * Оглавление секций (быстрый поиск по `grep -n "SEC:sim-"`):
 * - `[SEC:sim-storage]`  — чтение/запись `cdt.controls.v1` и 2D-fallback при недоступности WebGL.
 * - `[SEC:sim-state]`    — состояние, рефы мира/физики/рекордера, раскладка `cdt.layout.v1`, профиль геймпада.
 * - `[SEC:sim-actions]`  — `setTurnSignal`, `setGear`, `toggleEngine`, `resetAttempt` и сброс при смене мира.
 * - `[SEC:sim-loop]`     — инициализация `SceneController`, `requestAnimationFrame`, аккумулятор `FIXED_DT = 1/60`, автосохранение.
 * - `[SEC:sim-keyboard]` — глобальные горячие клавиши и защита от залипания при `blur`.
 * - `[SEC:sim-pointer]`  — мышь на холсте, экранный SVG-руль, мультитач-безопасные педали, загрузка файла OSM.
 * - `[SEC:sim-toolbar]`  — верхняя панель выбора сценария, импорта OSM и кнопки «Завершить → Разбор».
 * - `[SEC:sim-mirrors]`  — зеркала (`320×96` заднее, `320×160` боковые; остаются видимыми по `H`) и экранный руль.
 * - `[SEC:sim-hud]`      — штрафы, знаки/светофор/FPS, строка экзаменатора, настройки управления, справка, камера.
 * - `[SEC:sim-cluster]`  — приборная панель, селектор `P/R/N/D`, кнопки `I/РН/B/L`, раздельные педали и подвал ODbL.
 */
import { KeyBindingsEditor } from "./KeyBindingsEditor";
import { keyLabel, loadKeyBindings, logicalKey } from "../input/keyBindings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadGamepadProfile, readBrowserGamepad, saveGamepadProfile } from "../input/browserGamepads";
import { createAxisArming, readGamepad, updateAxisArming, type GamepadProfile } from "../input/gamepad";
import { buildRouteCorridorPolygon } from "../maps/boundary";
import { cropOsmPackToPolygon, parseMapFileText, type NormalizedOsmPack } from "../maps/osmLoader";
import { buildRouteFromRoads, listRouteCandidates, streetNameAt } from "../maps/route";
import { checkScenarioRoute } from "../maps/routeCheck";
import { EngineSound } from "../audio/engineSound";
import {
  clampVolume,
  radioStationsFor,
  renderTrackWav,
  trackCacheKey,
  VOLUME_STEP,
  type RadioStation,
} from "../audio/radioCatalog";
import * as trackStore from "../audio/trackStore";
import { type SavedTrack } from "../audio/trackStore";
import {
  DEFAULT_HEAD_UNIT_STATE,
  HEAD_UNIT_CLIPS,
  HEAD_UNIT_MODES,
  RADIO_STATIONS,
  setActiveRadioStations,
  type HeadUnitMode,
  type HeadUnitState,
} from "../render/cockpitDisplays";
import { detentLabel, type HeadDetentId } from "../render/headLook";
import { getPlayerCar } from "../sim/playerCar";
import { SceneController, type PerfMetrics } from "../render/sceneController";
import { SHIFTER_LAYOUT, type CockpitControlId, type ShifterHitId } from "../render/vehiclesAndPeds";
import { buildScenarioWorld } from "../scenarios/catalog";
import { customFromOsmPack, type CustomScenarioDef } from "../scenarios/custom";
import { autoFixScenarioRoute } from "../scenarios/editorOps";
import { evaluateAttempt, type EvaluationResult, type RuleSet } from "../scoring/rules";
import {
  applyShifterTarget,
  checkEngineToggle,
  checkGearChange,
  shiftLockState,
  advanceKeyboardThrottle,
  stepKeyboardGear,
  stepGearSequential,
  stepShifterGate,
  type ShifterTarget,
} from "../sim/controls";
import { AttemptRecorder, quantizeInput, type RecordedAttempt } from "../sim/recorder";
import { SpatialGrid } from "../sim/spatialGrid";
import { createInitialInput, createInitialState, createReadyInput, defaultGearForWorld, stepSimulation } from "../sim/step";
import type {
  CalibrationConfig,
  CameraMode,
  Gear,
  InputState,
  QualityPreset,
  ScenarioId,
  SimEvent,
  SimState,
  WorldData,
} from "../sim/types";
import {
  carGeometry,
  clamp,
  ENGINE_REDLINE_RPM,
  FIXED_DT,
  formatGearLabel,
  getCarCorners,
  getTrafficLightPhase,
  getTurnSignalFlash,
  isManualGear,
  MANUAL_STALL_DOWN_KMH,
  MAX_FORWARD_GEAR,
  normalizeWheelLock,
  SHIFT_HINT_RPM,
  STEER_WHEEL,
} from "../sim/vehicle";
import { Chip, Icon } from "./Icons";
import {
  FloatingPanel,
  loadLayout,
  saveLayout,
  loadLayerOrder,
  saveLayerOrder,
  loadPanelState,
  savePanelState,
  promotePanelToFront,
  resolvePanelZIndex,
  type LayoutMap,
  type PanelLayout,
  type PanelStateMap,
} from "./FloatingPanel";
import { GamepadPanel } from "./GamepadPanel";
import { SteeringLimitControl } from "./SteeringLimitControl";

type Props = {
  /** Тренажёр примонтирован всегда, но работает, пока его вкладка активна */
  active: boolean;
  menusHidden: boolean;
  onToggleMenus: () => void;
  scenarioId: ScenarioId;
  onScenarioChange: (id: ScenarioId) => void;
  calibration: CalibrationConfig;
  onWheelLockChange: (deg: number) => void;
  ruleSet: RuleSet;
  customOsm: NormalizedOsmPack | null;
  rawCustomOsm: NormalizedOsmPack | null;
  onCustomOsmChange: (pack: NormalizedOsmPack | null, rawPack?: NormalizedOsmPack | null) => void;
  onEditOsmInEditor: (pack: NormalizedOsmPack, rawPack: NormalizedOsmPack | null) => void;
  customDef: CustomScenarioDef;
  onAttemptSaved: (attempt: RecordedAttempt, openDebrief: boolean, quiet?: boolean) => void;
  onNotify: (msg: string) => void;
};

// === [SEC:sim-storage] Настройки клавиатурного руля и 2D-fallback без WebGL ===
const CONTROLS_KEY = "cdt.controls.v1";
const DEFAULT_STEER_KEY_RATE = 340;
/** Старт и сброс попытки всегда «холодные»: ДВС заглушен, КПП P. */
const COLD_START = false;

function loadControls(): { steerKeyRate: number } {
  try {
    const raw = localStorage.getItem(CONTROLS_KEY);
    const parsed = raw ? (JSON.parse(raw) as { steerKeyRate?: number }) : {};
    const rate = Number(parsed.steerKeyRate);
    return {
      steerKeyRate: Number.isFinite(rate) ? clamp(rate, 60, 900) : DEFAULT_STEER_KEY_RATE,
    };
  } catch {
    return { steerKeyRate: DEFAULT_STEER_KEY_RATE };
  }
}

function saveControls(c: { steerKeyRate: number }): void {
  try {
    localStorage.setItem(CONTROLS_KEY, JSON.stringify(c));
  } catch {
    // storage blocked
  }
}

/** Ключ сохранения режима 7" ШГУ (ассистент / радио / клип / выкл.) и выбранной станции. */
const HEAD_UNIT_KEY = "cdt.headunit.v1";

function loadHeadUnit(): HeadUnitState {
  try {
    const raw = localStorage.getItem(HEAD_UNIT_KEY);
    if (!raw) return DEFAULT_HEAD_UNIT_STATE;
    const parsed = JSON.parse(raw) as Partial<HeadUnitState>;
    const mode: HeadUnitMode =
      parsed.mode && HEAD_UNIT_MODES.some((m) => m.id === parsed.mode) ? parsed.mode : DEFAULT_HEAD_UNIT_STATE.mode;
    // Верхняя граница — по максимальному каталогу; список сценария может быть короче, его обрежет эффект смены сценария
    const stationIndex = clamp(Math.round(Number(parsed.stationIndex) || 0), 0, RADIO_STATIONS.length - 1);
    const clipIndex = clamp(Math.round(Number(parsed.clipIndex) || 0), 0, HEAD_UNIT_CLIPS.length - 1);
    const source =
      parsed.source === "saved" || parsed.source === "synth" || parsed.source === "stream"
        ? parsed.source
        : DEFAULT_HEAD_UNIT_STATE.source;
    return {
      mode,
      stationIndex,
      clipIndex,
      radioPlaying: Boolean(parsed.radioPlaying),
      volume: clampVolume(Number(parsed.volume ?? DEFAULT_HEAD_UNIT_STATE.volume)),
      source,
      savedTrackKey: typeof parsed.savedTrackKey === "string" ? parsed.savedTrackKey : null,
      streamStatus: "idle",
      savedCount: 0,
      promoSlot: DEFAULT_HEAD_UNIT_STATE.promoSlot ?? null,
    };
  } catch {
    return DEFAULT_HEAD_UNIT_STATE;
  }
}

function saveHeadUnit(h: HeadUnitState): void {
  try {
    localStorage.setItem(HEAD_UNIT_KEY, JSON.stringify(h));
  } catch {
    // storage blocked
  }
}

type HudSnapshot = {
  state: SimState;
  evalRes: EvaluationResult;
  speedLimit: number;
  gridChecks: number;
  totalObstacles: number;
  perf: PerfMetrics;
  nextSignal: { phase: string; sec: number; forbidden: boolean } | null;
  latestViolation: { title: string; points: number; detail: string; at: number } | null;
};

/** 2D-отрисовка сверху (фолбэк при отключённом WebGL на слабом тонком клиенте). */
function render2DFallback(canvas: HTMLCanvasElement, s: SimState, world: WorldData): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#16222c";
  ctx.fillRect(0, 0, w, h);

  const scale = world.scenarioId === "city_osm" ? 9 : 18;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  // +Z вверх экрана, +X влево экрана (как в инварианте №1)
  ctx.scale(-scale, -scale);
  ctx.translate(-s.x, -s.z);

  // Дороги
  ctx.strokeStyle = "#2d3742";
  ctx.lineCap = "square";
  for (const r of world.roads) {
    ctx.lineWidth = r.width;
    ctx.beginPath();
    r.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.z) : ctx.lineTo(p.x, p.z)));
    ctx.stroke();
  }

  // Боксы
  for (const b of world.bays) {
    ctx.save();
    ctx.translate(b.cx, b.cz);
    ctx.rotate(-b.h);
    ctx.strokeStyle = s.finishedBayId === b.id ? "#52d6bd" : b.occupied ? "#64748b" : "#f8fafc";
    ctx.lineWidth = 0.12;
    ctx.strokeRect(-b.width / 2, -b.length / 2, b.width, b.length);
    ctx.restore();
  }

  // Препятствия
  for (const o of world.obstacles) {
    ctx.save();
    ctx.translate(o.cx, o.cz);
    ctx.rotate(-o.h);
    ctx.fillStyle = o.kind === "parked_car" ? "#60a5fa" : o.kind === "building" ? "#475569" : "#94a3b8";
    ctx.fillRect(-o.halfX, -o.halfZ, o.halfX * 2, o.halfZ * 2);
    ctx.restore();
  }

  // Автомобиль игрока — по габаритам выбранной машины, а не по эталонному Ceed
  const corners = getCarCorners(s.x, s.z, s.h, carGeometry(s.carId));
  ctx.fillStyle = "#f5b942";
  ctx.beginPath();
  corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.z) : ctx.lineTo(c.x, c.z)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const HUD_PANEL_CATALOG: ReadonlyArray<{ id: string; label: string; group: "hud" | "mirror" }> = [
  { id: "scorePanel", label: "Оценка", group: "hud" },
  { id: "speedPanel", label: "Лимит и FPS", group: "hud" },
  { id: "statusBar", label: "Задание", group: "hud" },
  { id: "cluster", label: "Приборы и КПП", group: "hud" },
  { id: "camToggles", label: "Камера и вид", group: "hud" },
  { id: "steeringWheel", label: "Руль", group: "hud" },
  { id: "pedalBrake", label: "Педаль тормоза", group: "hud" },
  { id: "pedalGas", label: "Педаль газа", group: "hud" },
  { id: "mirrorRear", label: "Зеркало заднего вида", group: "mirror" },
  { id: "mirrorLeft", label: "Левое зеркало", group: "mirror" },
  { id: "mirrorRight", label: "Правое зеркало", group: "mirror" },
];

// === [SEC:sim-state] Состояние компонента, рефы симуляции, раскладка и геймпад ===
export function SimulatorView({
  active,
  menusHidden,
  onToggleMenus,
  scenarioId,
  onScenarioChange,
  calibration,
  onWheelLockChange,
  ruleSet,
  customOsm,
  rawCustomOsm,
  onCustomOsmChange,
  onEditOsmInEditor,
  customDef,
  onAttemptSaved,
  onNotify,
}: Props) {
  const activeRef = useRef(true);
  const { perpBayWidth, perpBayLength, aisleWidth, parBayLength, parBayWidth } = calibration;
  // Новое значение выворота не изменяет площадку и не должно сбрасывать двигатель, позу или запись.
  const world = useMemo(
    () => buildScenarioWorld(scenarioId, { perpBayWidth, perpBayLength, aisleWidth, parBayLength, parBayWidth }, customOsm, customDef),
    [scenarioId, customOsm, customDef, perpBayWidth, perpBayLength, aisleWidth, parBayLength, parBayWidth]
  );
  const wheelLimit = normalizeWheelLock(calibration.maxInnerWheelDeg);

  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  /**
   * Точка внимания водителя в салоне: слева/справа — боковые зеркала, по центру — дорога
   * с салонным зеркалом в верхней трети кадра. Стрелки ←/→ переключают её по кругу.
   */
  const [headDetentUi, setHeadDetentUi] = useState<HeadDetentId>("road");
  const [quality, setQuality] = useState<QualityPreset>("medium");
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [showMirrors, setShowMirrors] = useState(true);
  const [showRearMirror, setShowRearMirror] = useState(true);
  const [uiHidden, setUiHidden] = useState(false);
  const [bindings, setBindings] = useState(loadKeyBindings);
  const bindingsRef = useRef(bindings);

  const [showHelp, setShowHelp] = useState(false);
  const [helpCollapsed, setHelpCollapsed] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [showPanelsMenu, setShowPanelsMenu] = useState(false);
  const [osmBarCollapsed, setOsmBarCollapsed] = useState(false);
  const [osmBarClosed, setOsmBarClosed] = useState(false);
  const [footerCollapsed, setFooterCollapsed] = useState(false);
  const [showOsmCheck, setShowOsmCheck] = useState(false);
  const [osmRouteCandidate, setOsmRouteCandidate] = useState("");
  const [osmRouteReverse, setOsmRouteReverse] = useState(false);
  const [webglFallback, setWebglFallback] = useState(false);
  const [pedalVisual, setPedalVisual] = useState<{ gas: boolean; brake: boolean }>({ gas: false, brake: false });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [immersive, setImmersive] = useState(false);
  const previousUiHiddenRef = useRef(false);
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const leaveImmersive = useCallback(() => {
    setImmersive(false);
    setUiHidden(previousUiHiddenRef.current);
    if (document.fullscreenElement === containerRef.current) {
      void document.exitFullscreen().catch(() => {});
    }
    fullscreenButtonRef.current?.focus({ preventScroll: true });
  }, []);
  const enterImmersive = useCallback(() => {
    const host = containerRef.current;
    if (!host) return;
    previousUiHiddenRef.current = uiHidden;
    setShowHelp(false);
    setShowControls(false);
    setImmersive(true);
    setUiHidden(true);
    // В iframe fullscreen может запрещаться Permissions Policy: CSS-режим остаётся рабочим.
    if (host.requestFullscreen) void host.requestFullscreen().catch(() => {});
  }, [uiHidden]);
  useEffect(() => {
    if (!immersive) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onFullscreenChange = () => {
      if (document.fullscreenElement !== containerRef.current) leaveImmersive();
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.code === "Escape") { e.preventDefault(); leaveImmersive(); }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onEscape);
    };
  }, [immersive, leaveImmersive]);
  useEffect(() => {
    if (!active && immersive) leaveImmersive();
  }, [active, immersive, leaveImmersive]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rearMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const leftMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const rightMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const wheelSvgRef = useRef<SVGSVGElement | null>(null);
  const wheelGroupRef = useRef<SVGGElement | null>(null);

  // Настраиваемая скорость руления клавишами A/D (°/с руля) и раскладка плавающих окон
  const [steerKeyRate, setSteerKeyRate] = useState<number>(() => loadControls().steerKeyRate);
  const steerRateRef = useRef<number>(steerKeyRate);
  const [showControls, setShowControls] = useState(false);
  // Мультимедиа 7" ШГУ: режим экрана и станция тюнера сохраняются в localStorage (`cdt.headunit.v1`)
  const [headUnit, setHeadUnit] = useState<HeadUnitState>(loadHeadUnit);
  const headUnitRef = useRef<HeadUnitState>(headUnit);
  const [cockpitControlUi, setCockpitControlUi] = useState<{
    id: CockpitControlId;
    x: number;
    y: number;
  } | null>(null);
  const [layout, setLayout] = useState<LayoutMap>(loadLayout);
  const [layerOrder, setLayerOrder] = useState<string[]>(loadLayerOrder);

  // USB-руль / педали / геймпад (Gamepad API). По умолчанию выключено: пока устройство явно
  // не включено в панели «Управление», оно не опрашивается и на управление не влияет.
  const [padProfile, setPadProfile] = useState<GamepadProfile>(loadGamepadProfile);
  const padProfileRef = useRef<GamepadProfile>(padProfile);
  const padArmingRef = useRef(createAxisArming());
  const prevPadButtonsRef = useRef<Record<string, boolean>>({});
  const actionsRef = useRef<{
    toggleEngine: () => void;
    setGear: (g: Gear) => void;
    setTurnSignal: (s: InputState["signal"]) => void;
  } | null>(null);

  useEffect(() => {
    padProfileRef.current = padProfile;
    saveGamepadProfile(padProfile);
  }, [padProfile]);

  useEffect(() => {
    steerRateRef.current = steerKeyRate;
    saveControls({ steerKeyRate });
  }, [steerKeyRate]);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  useEffect(() => {
    saveLayerOrder(layerOrder);
  }, [layerOrder]);

  const [panelState, setPanelState] = useState<PanelStateMap>(loadPanelState);
  useEffect(() => {
    savePanelState(panelState);
  }, [panelState]);

  const isPanelClosed = (id: string) => panelState.closed.includes(id);
  const isPanelCollapsed = (id: string) => panelState.collapsed.includes(id);

  const handleLayoutChange = useCallback((id: string, next: PanelLayout) => {
    setLayout((prev) => ({ ...prev, [id]: next }));
  }, []);

  const handleBringPanelToFront = useCallback((id: string) => {
    setLayerOrder((prev) => promotePanelToFront(prev, id));
  }, []);

  const clearSinglePedal = useCallback((id: string) => {
    if (id !== "pedalGas" && id !== "pedalBrake") return;
    const which = id === "pedalGas" ? "gas" : "brake";
    touchPedalRef.current[which] = false;
    setPedalVisual((prev) => (prev[which] ? { ...prev, [which]: false } : prev));
  }, []);

  const handleToggleCollapse = useCallback(
    (id: string) => {
      clearSinglePedal(id);
      setPanelState((prev) => {
        const wasCollapsed = prev.collapsed.includes(id);
        return {
          closed: prev.closed.filter((x) => x !== id),
          collapsed: wasCollapsed ? prev.collapsed.filter((x) => x !== id) : [...prev.collapsed, id],
        };
      });
    },
    [clearSinglePedal]
  );

  const handleClosePanel = useCallback(
    (id: string) => {
      clearSinglePedal(id);
      setPanelState((prev) => ({
        collapsed: prev.collapsed.filter((x) => x !== id),
        closed: prev.closed.includes(id) ? prev.closed : [...prev.closed, id],
      }));
    },
    [clearSinglePedal]
  );

  const handleRestorePanel = useCallback((id: string) => {
    if (id === "mirrorRear") setShowRearMirror(true);
    if (id === "mirrorLeft" || id === "mirrorRight") setShowMirrors(true);
    setPanelState((prev) => ({
      collapsed: prev.collapsed.filter((x) => x !== id),
      closed: prev.closed.filter((x) => x !== id),
    }));
  }, []);

  const handleRestoreAllPanels = useCallback(() => {
    setShowRearMirror(true);
    setShowMirrors(true);
    setPanelState({ collapsed: [], closed: [] });
    setShowPanelsMenu(false);
  }, []);

  const handleCollapseAllHud = useCallback(() => {
    clearSinglePedal("pedalGas");
    clearSinglePedal("pedalBrake");
    const hudIds = HUD_PANEL_CATALOG.filter((p) => p.group === "hud").map((p) => p.id);
    setPanelState((prev) => ({
      closed: prev.closed,
      collapsed: Array.from(new Set([...prev.collapsed, ...hudIds.filter((id) => !prev.closed.includes(id))])),
    }));
  }, [clearSinglePedal]);

  const toggleSideMirrors = useCallback(() => {
    const anyClosed =
      panelState.closed.includes("mirrorLeft") || panelState.closed.includes("mirrorRight");
    if (!showMirrors || anyClosed) {
      setShowMirrors(true);
      setPanelState((prev) => ({
        collapsed: prev.collapsed.filter((id) => id !== "mirrorLeft" && id !== "mirrorRight"),
        closed: prev.closed.filter((id) => id !== "mirrorLeft" && id !== "mirrorRight"),
      }));
    } else {
      setShowMirrors(false);
    }
  }, [showMirrors, panelState.closed]);

  const toggleRearMirror = useCallback(() => {
    const wasClosed = panelState.closed.includes("mirrorRear");
    if (!showRearMirror || wasClosed) {
      setShowRearMirror(true);
      setPanelState((prev) => ({
        collapsed: prev.collapsed.filter((id) => id !== "mirrorRear"),
        closed: prev.closed.filter((id) => id !== "mirrorRear"),
      }));
    } else {
      setShowRearMirror(false);
    }
  }, [showRearMirror, panelState.closed]);

  const panelZ = (id: string, baseZ: number) => resolvePanelZIndex(id, baseZ, layerOrder);
  const isFrontPanel = (id: string) => layerOrder.length > 0 && layerOrder[layerOrder.length - 1] === id;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Мутабельные рефы симуляционного цикла (без лишних ререндеров на 60 Гц)
  const sceneCtrlRef = useRef<SceneController | null>(null);
  const worldRef = useRef<WorldData>(world);
  const gridRef = useRef<SpatialGrid>(new SpatialGrid(world.obstacles, 10));
  const calRef = useRef<CalibrationConfig>(calibration);
  const ruleRef = useRef<RuleSet>(ruleSet);
  // Всегда холодный старт: ДВС заглушен, КПП в P (Parking), ручник затянут.
  const stateRef = useRef<SimState>(createInitialState(world, false, wheelLimit));
  const inputRef = useRef<InputState>(createInitialInput());
  const recorderRef = useRef<AttemptRecorder>(new AttemptRecorder(stateRef.current, false));
  const autoSavedRef = useRef(false);
  // Колбэк сохранения попытки держим в ref: его изменение (например, имени ученика)
  // не должно пересоздавать сцену и цикл симуляции.
  const attemptSavedRef = useRef(onAttemptSaved);
  const rideDirtyRef = useRef(false);
  const recordingActiveRef = useRef(true);
  const lastAutoSaveRef = useRef(0);

  useEffect(() => {
    attemptSavedRef.current = onAttemptSaved;
  }, [onAttemptSaved]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Страховочное сохранение незавершённого заезда: периодически и при уходе со вкладки,
  // иначе десять минут практики пропадают при закрытии вкладки
  useEffect(() => {
    const saveUnfinished = () => {
      const st = stateRef.current;
      if (!recordingActiveRef.current || !rideDirtyRef.current || autoSavedRef.current || !st.hasMoved) return;
      rideDirtyRef.current = false;
      lastAutoSaveRef.current = Date.now();
      // closed = false: это страховочная копия незавершённого заезда
      attemptSavedRef.current(
        recorderRef.current.snapshot(st, worldRef.current, calRef.current, ruleRef.current, false),
        false,
        true
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveUnfinished();
    };
    const timer = window.setInterval(() => {
      if (Date.now() - lastAutoSaveRef.current > 45_000) saveUnfinished();
    }, 15_000);
    window.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", saveUnfinished);
    return () => {
      window.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", saveUnfinished);
      window.clearInterval(timer);
    };
  }, []);

  const keysRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    bindingsRef.current = bindings;
    keysRef.current = {};
    inputRef.current.throttle = 0;
    keyboardThrottleRef.current = 0;
    inputRef.current.brake = 0;
    releaseHorn();
    try { localStorage.setItem("cdt.keybindings.v1", JSON.stringify(bindings)); }
    catch { onNotify("Не удалось сохранить клавиши: хранилище браузера недоступно"); }
  }, [bindings]);

  const keyboardThrottleRef = useRef(0);
  const touchPedalRef = useRef<{ gas: boolean; brake: boolean }>({ gas: false, brake: false });
  const pedalOwner = useRef<{ gas: number | null; brake: number | null }>({ gas: null, brake: null });
  const releasePedals = useCallback(() => {
    keyboardThrottleRef.current = 0;
    pedalOwner.current = { gas: null, brake: null };
    touchPedalRef.current = { gas: false, brake: false };
    setPedalVisual({ gas: false, brake: false });
  }, []);
  useEffect(() => {
    if (!active || uiHidden) releasePedals();
  }, [active, uiHidden, releasePedals]);
  const holdingSteerRef = useRef(false);
  const latestViolationRef = useRef<HudSnapshot["latestViolation"]>(null);
  const optsRef = useRef({
    cameraMode,
    quality,
    showTrajectory,
    showMirrors,
    showRearMirror,
    showLearnerSign: calibration.showLearnerSign,
    drawRadius: 145,
  });

  const [shifterGlance, setShifterGlance] = useState(false);
  const [hudGearHint, setHudGearHint] = useState<{
    slot: "P" | "R" | "N" | "D";
    left: number;
    top: number;
    below: boolean;
  } | null>(null);
  const [cockpitShifterUi, setCockpitShifterUi] = useState<{
    hit: ShifterHitId;
    dragging: boolean;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (cameraMode !== "cockpit") {
      setShifterGlance(false);
      setCockpitShifterUi(null);
      sceneCtrlRef.current?.setShifterInteraction(null, false, 0);
    }
  }, [cameraMode]);

  useEffect(() => {
    if (uiHidden) setHudGearHint(null);
  }, [uiHidden]);

  useEffect(() => {
    optsRef.current = {
      cameraMode,
      quality,
      showTrajectory,
      showMirrors,
      showRearMirror,
      showLearnerSign: calibration.showLearnerSign,
      drawRadius: quality === "low" ? 95 : quality === "medium" ? 145 : 220,
    };
  }, [cameraMode, quality, showTrajectory, showMirrors, showRearMirror, calibration.showLearnerSign]);

  useEffect(() => { sceneCtrlRef.current?.applyQuality(quality); }, [quality]);

  useEffect(() => {
    calRef.current = calibration;
  }, [calibration]);

  useEffect(() => {
    ruleRef.current = ruleSet;
  }, [ruleSet]);

  const [hud, setHud] = useState<HudSnapshot>(() => ({
    state: stateRef.current,
    evalRes: evaluateAttempt([], 0, ruleSet),
    speedLimit: world.defaultSpeedLimitKmh,
    gridChecks: 0,
    totalObstacles: world.obstacles.length,
    perf: { fps: 60, p95FrameMs: 16.6, visibleBuildings: 0, totalBuildings: 0 },
    nextSignal: null,
    latestViolation: null,
  }));

  // === [SEC:sim-actions] Команды поворотников, АКПП, стартера и сброса попытки ===
  /**
   * Живое усилие на педали тормоза `0..1` из клавиатуры (S), экранной педали и USB-геймпада.
   * Нужно блокировке BTSI (`checkGearChange`): клавиша S должна снимать селектор с P ещё до следующего тика.
   */
  const liveBrakePressure = useCallback(() => {
    const keys = keysRef.current;
    const pressed = Boolean(keys.KeyS || touchPedalRef.current.brake);
    return Math.max(inputRef.current.brake, pressed ? 1 : 0);
  }, []);

  const setTurnSignal = useCallback((signal: InputState["signal"]) => {
    inputRef.current.signal = signal;
    // Reflect a signal button/key press immediately instead of waiting for the next HUD tick.
    setHud((current) => ({ ...current, state: { ...current.state, signal } }));
  }, []);

  /** Выбор режима АКПП с блокировками (src/sim/controls.ts): P — только на остановке, выход из P — при запущенном ДВС. */
  const setGear = useCallback(
    (gear: Gear) => {
      const inp = inputRef.current;
      const err = checkGearChange({ ...inp, brake: liveBrakePressure() }, stateRef.current.v, gear);
      if (err) {
        onNotify(err);
        return;
      }
      inp.gear = gear;
      setHud((current) => ({ ...current, state: { ...current.state, gear } }));
    },
    [liveBrakePressure, onNotify]
  );

  /** Секвентальное переключение 6-ст. КПП Shiftronic по клавише Shift (+1 вверх, −1 вниз). */
  const shiftGear = useCallback(
    (dir: 1 | -1) => {
      const inp = inputRef.current;
      const st = stateRef.current;
      const { next, blockedReason } = stepGearSequential(
        { ...inp, brake: liveBrakePressure() },
        st.v,
        st.autoSubGear,
        dir
      );
      if (blockedReason) {
        onNotify(blockedReason);
        return;
      }
      if (!next) return;
      inp.gear = next;
      const nextSub = isManualGear(next) ? Number(next) : st.autoSubGear;
      setHud((current) => ({
        ...current,
        state: { ...current.state, gear: next, autoSubGear: nextSub },
      }));
    },
    [onNotify]
  );

  // Реф таймера подавления повтора предупреждений при плавном ведении 3D-рычага АКПП мышью
  const shifterNotifyAtRef = useRef(0);
  const notifyShifterOnce = useCallback(
    (msg: string, throttle = false) => {
      const now = performance.now();
      if (throttle && now - shifterNotifyAtRef.current < 900) return;
      shifterNotifyAtRef.current = now;
      onNotify(msg);
    },
    [onNotify]
  );

  /** Переключение передачи 3D-рычагом АКПП Shiftronic в салоне (перетаскивание или клик по пазу кулисы). */
  const engageCockpitShifter = useCallback(
    (target: ShifterTarget, opts?: { toggleManualOnClick?: boolean; fromDrag?: boolean }): Gear | null => {
      const inp = inputRef.current;
      const st = stateRef.current;
      const { next, blockedReason } = applyShifterTarget(
        { ...inp, brake: liveBrakePressure() },
        st.v,
        st.autoSubGear,
        target,
        { toggleManualOnClick: opts?.toggleManualOnClick }
      );
      if (blockedReason) {
        notifyShifterOnce(blockedReason, Boolean(opts?.fromDrag));
        return null;
      }
      if (!next) return null;
      inp.gear = next;
      const nextSub = isManualGear(next) ? Number(next) : st.autoSubGear;
      setHud((current) => ({
        ...current,
        state: { ...current.state, gear: next, autoSubGear: nextSub },
      }));
      return next;
    },
    [liveBrakePressure, notifyShifterOnce]
  );

  /** Пошаговое переключение 3D-рычага АКПП (колесом мыши или одиночным кликом по рукоятке). */
  const stepCockpitShifter = useCallback(
    (dir: 1 | -1) => {
      const inp = inputRef.current;
      const st = stateRef.current;
      const { next, blockedReason } = stepShifterGate(
        { ...inp, brake: liveBrakePressure() },
        st.v,
        st.autoSubGear,
        dir
      );
      if (blockedReason) {
        notifyShifterOnce(blockedReason, false);
        return;
      }
      if (!next) return;
      inp.gear = next;
      const nextSub = isManualGear(next) ? Number(next) : st.autoSubGear;
      setHud((current) => ({
        ...current,
        state: { ...current.state, gear: next, autoSubGear: nextSub },
      }));
    },
    [liveBrakePressure, notifyShifterOnce]
  );

  /** Быстрый взгляд водителя на 3D-рычаг АКПП в салоне и обратно на дорогу (клавиша G или кнопка «КПП»). */
  const toggleShifterGlance = useCallback(() => {
    const ctrl = sceneCtrlRef.current;
    if (!ctrl) return;
    if (optsRef.current.cameraMode !== "cockpit") {
      optsRef.current.cameraMode = "cockpit";
      setCameraMode("cockpit");
      if (!ctrl.isCockpitShifterView()) {
        setShifterGlance(ctrl.toggleCockpitShifterView());
      } else {
        setShifterGlance(true);
      }
      return;
    }
    const looking = ctrl.toggleCockpitShifterView();
    setShifterGlance(looking);
    if (!looking) {
      setCockpitShifterUi(null);
      ctrl.setShifterInteraction(null, false, 0);
    }
  }, []);

  /** Запуск ДВС разрешён только в P или N (src/sim/controls.ts); заглушить можно в любом режиме. */
  const toggleEngine = useCallback(() => {
    const inp = inputRef.current;
    const err = checkEngineToggle(inp);
    if (err) {
      onNotify(err);
      return;
    }
    inp.engineOn = !inp.engineOn;
    setHud((current) => ({
      ...current,
      state: { ...current.state, engineOn: inp.engineOn },
    }));
  }, [onNotify]);

  // === [SEC:sim-media] 7" ШГУ: реальные интернет-радиостанции, сохранённые (кэшированные) треки, VOL/TUNE ===
  /** Переключает режим экрана 7" ШГУ по кругу: ассистент → радио → клип → выкл. */
  const cycleHeadUnitMode = useCallback(() => {
    setHeadUnit((prev) => {
      const idx = HEAD_UNIT_MODES.findIndex((m) => m.id === prev.mode);
      const next = HEAD_UNIT_MODES[(idx + 1) % HEAD_UNIT_MODES.length];
      onNotify(`Экран 7" ШГУ: ${next.label}`);
      return {
        ...prev,
        mode: next.id,
        radioPlaying: next.id === "radio" ? true : next.id === "clip" ? true : false,
      };
    });
  }, [onNotify]);

  /** Прямой выбор режима экрана ШГУ (кнопки в панели «Управление» и на 3D-экране). */
  const setHeadUnitMode = useCallback(
    (mode: HeadUnitMode) => {
      setHeadUnit((prev) => ({
        ...prev,
        mode,
        radioPlaying: mode === "radio" ? true : mode === "clip" ? true : false,
      }));
      onNotify(`Экран 7" ШГУ: ${HEAD_UNIT_MODES.find((m) => m.id === mode)?.label ?? mode}`);
    },
    [onNotify]
  );

  /** Листает реальные интернет-станции (`dir = +1` вправо по шкале, `−1` влево) и запускает эфир. */
  const stepRadioStation = useCallback(
    (dir: 1 | -1) => {
      setHeadUnit((prev) => {
        const list = radioStationsRef.current;
        const stationIndex = ((prev.stationIndex + dir + list.length) % list.length + list.length) % list.length;
        const st = list[stationIndex];
        onNotify(`FM ${st.freq} · ${st.name} — ${st.genre}`);
        return {
          ...prev,
          stationIndex,
          mode: "radio",
          radioPlaying: true,
          source: "stream",
          savedTrackKey: null,
        };
      });
    },
    [onNotify]
  );

  /** Пауза/воспроизведение радио (шайба VOL в 3D-салоне и кнопка в панели). */
  const toggleRadioPlay = useCallback(() => {
    setHeadUnit((prev) => {
      const radioPlaying = !prev.radioPlaying;
      onNotify(radioPlaying ? "Эфир включён" : "Эфир на паузе");
      return { ...prev, mode: "radio", radioPlaying };
    });
  }, [onNotify]);

  /** Громкость шайбой VOL (шаг 10 %, диапазон 0..100 %). */
  const changeVolume = useCallback(
    (delta: number) => {
      setHeadUnit((prev) => {
        const volume = clampVolume((prev.volume ?? 0.7) + delta);
        onNotify(`Громкость ШГУ: ${Math.round(volume * 100)}%`);
        return { ...prev, volume };
      });
    },
    [onNotify]
  );

  /** Переключает видеоклип на экране ШГУ. */
  const stepHeadUnitClip = useCallback(() => {
    setHeadUnit((prev) => {
      const clipIndex = (prev.clipIndex + 1) % HEAD_UNIT_CLIPS.length;
      onNotify(`Клип: ${HEAD_UNIT_CLIPS[clipIndex].title}`);
      return { ...prev, clipIndex, mode: "clip", radioPlaying: true };
    });
  }, [onNotify]);

  /**
   * Активное хранилище треков: по умолчанию IndexedDB `cdt-audio`, но смоук может подменить его
   * на in-memory реализацию через `window.__cdtAudioStore` (в закрытом CI IndexedDB ограничена).
   */
  const store = () =>
    (typeof window !== "undefined" &&
      (window as unknown as { __cdtAudioStore?: typeof trackStore }).__cdtAudioStore) ||
    trackStore;

  // Список сохранённых (закэшированных) треков для панели ШГУ
  const [savedTracks, setSavedTracks] = useState<Array<Omit<SavedTrack, "blob">>>([]);
  const refreshSavedTracks = useCallback(async () => {
    const list = await store().listTracks();
    setSavedTracks(list);
    setHeadUnit((prev) =>
      prev.savedCount === list.length ? prev : { ...prev, savedCount: list.length }
    );
    return list;
  }, []);
  useEffect(() => {
    void refreshSavedTracks();
  }, [refreshSavedTracks]);

  // Живой звук: реальный интернет-поток станции либо кэшированный трек
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  /** Останавливает живой звук (поток или кэш-трек). */
  const stopAudio = useCallback(() => {
    const el = audioElRef.current;
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }, []);

  /**
   * Включает звук: живой интернет-эфир выбранной станции.
   * При ошибке сети/потока ШГУ честно сообщает «эфир недоступен» и остаётся тихим — без фальшивого синтеза.
   */
  const playStationStream = useCallback(
    (station: RadioStation) => {
      const el = audioElRef.current;
      if (!el) return;
      stopAudio();
      setAudioError(null);
      if (
        typeof el.canPlayType === "function" &&
        el.canPlayType("audio/mpeg") === "" &&
        el.canPlayType('audio/mp4; codecs="mp4a.40.2"') === ""
      ) {
        setAudioError("Браузер не поддерживает MP3/AAC-потоки");
        return;
      }
      // CORS не запрашиваем: обычное воспроизведение работает с любым потоком, а анализ спектра не нужен
      el.src = station.streamUrl;
      el.volume = clampVolume(headUnitRef.current.volume);
      el.load();
      const started = el.play();
      if (started && typeof started.catch === "function") started.catch(() => undefined);
    },
    [stopAudio]
  );

  /** Включает сохранённый (закэшированный) трек из IndexedDB. */
  const playSavedTrack = useCallback(async (key: string) => {
    const el = audioElRef.current;
    if (!el) return;
    const track = await store().loadTrack(key);
    if (!track) {
      setAudioError("Трек не найден в кэше");
      return;
    }
    stopAudio();
    el.src = URL.createObjectURL(track.blob);
    el.volume = clampVolume(headUnitRef.current.volume);
    const started = el.play();
    if (started && typeof started.catch === "function") started.catch(() => undefined);
  }, [stopAudio]);

  /**
   * Сохраняет текущий эфир станции в кэш треков (`cdt-audio`) прямо во время поездки:
   * процедурный офлайн-рендер эфира в WAV → IndexedDB, сразу доступен для прослушивания без сети.
   */
  const saveCurrentTrack = useCallback(async () => {
    const list = radioStationsRef.current;
    const st = list[clamp(headUnitRef.current.stationIndex, 0, list.length - 1)];
    const seconds = 32;
    const key = trackCacheKey(st.id, seconds);
    const wav = renderTrackWav(st, seconds);
    const stored = await store().saveTrack({
      key,
      stationId: st.id,
      stationName: st.name,
      freq: st.freq,
      seconds,
      blob: new Blob([wav], { type: "audio/wav" }),
    });
    await refreshSavedTracks();
    onNotify(
      `Трек сохранён в кэш: FM ${st.freq} · ${st.name} · 32 с${stored ? "" : " (память вкладки)"}`
    );
    return key;
  }, [onNotify, refreshSavedTracks]);

  /** Удаляет трек из кэша ШГУ. */
  const removeSavedTrack = useCallback(
    async (key: string) => {
      await store().deleteTrack(key);
      await refreshSavedTracks();
      onNotify("Трек удалён из кэша ШГУ");
    },
    [onNotify, refreshSavedTracks]
  );

  // Слушатель событий аудиоэлемента: живой эфир/кэш-трек/ошибка сети
  useEffect(() => {
    const ctorAudio = typeof Audio !== "undefined" ? Audio : null;
    if (!ctorAudio) return;
    const el = new ctorAudio();
    el.preload = "none";
    audioElRef.current = el;
    const onPlaying = () => {
      setAudioError(null);
      setHeadUnit((prev) =>
        prev.streamStatus === "live" ? prev : { ...prev, streamStatus: "live" }
      );
    };
    const onWaiting = () => {
      setHeadUnit((prev) =>
        prev.streamStatus === "connecting" ? prev : { ...prev, streamStatus: "connecting" }
      );
    };
    const onError = () => {
      // Ошибка «пустого» элемента после stopAudio() — не сетевая проблема, статус не меняем
      if (!el.getAttribute("src")) return;
      setHeadUnit((prev) => ({ ...prev, streamStatus: "error" }));
      setAudioError("Интернет-эфир недоступен — проверьте сеть или сохраните трек из кэша");
    };
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("error", onError);
      el.pause();
      el.removeAttribute("src");
      el.load();
      audioElRef.current = null;
    };
  }, []);

  // Запуск/остановка звука при изменении режима, станции, источника и громкости
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    const wantsSound = headUnit.mode === "radio" && headUnit.radioPlaying && headUnit.source !== "synth";
    if (!wantsSound) {
      stopAudio();
      return;
    }
    el.volume = clampVolume(headUnit.volume);
    if (headUnit.source === "saved" && headUnit.savedTrackKey) {
      void playSavedTrack(headUnit.savedTrackKey);
    } else if (headUnit.mode === "radio") {
      setHeadUnit((prev) =>
        prev.streamStatus === "connecting" ? prev : { ...prev, streamStatus: "connecting" }
      );
      playStationStream(radioStationsRef.current[clamp(headUnit.stationIndex, 0, radioStationsRef.current.length - 1)]);
    }
    // playStationStream/playSavedTrack читают актуальные refs и не должны перезапускать звук
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headUnit.mode, headUnit.radioPlaying, headUnit.stationIndex, headUnit.source, headUnit.savedTrackKey]);

  // Громкость применяется мгновенно, без перезапуска потока
  useEffect(() => {
    const el = audioElRef.current;
    if (el) el.volume = clampVolume(headUnit.volume);
  }, [headUnit.volume]);

  // === [SEC:sim-audio] Процедурный звук ДВС/шин и звук ШГУ: старт по жесту, громкость и пауза ===
  const engineSoundRef = useRef<EngineSound | null>(null);
  /**
   * Клаксон как настоящее реле: H (удержание) и клик по накладке руля (короткий «би-бип»)
   * живут в одном счётчике. Таймер короткого сигнала не должен гасить нажатый H —
   * раньше он это делал, и звук обрывался сам.
   */
  const hornHeldRef = useRef(false);
  const hornPulseTimerRef = useRef<number | null>(null);
  const pressHorn = useCallback((pulse: boolean) => {
    if (!pulse) {
      hornHeldRef.current = true;
      return;
    }
    hornHeldRef.current = true;
    if (hornPulseTimerRef.current !== null) window.clearTimeout(hornPulseTimerRef.current);
    hornPulseTimerRef.current = window.setTimeout(() => {
      hornPulseTimerRef.current = null;
      hornHeldRef.current = false;
    }, 600);
  }, []);
  const releaseHorn = useCallback(() => {
    hornHeldRef.current = false;
    if (hornPulseTimerRef.current !== null) {
      window.clearTimeout(hornPulseTimerRef.current);
      hornPulseTimerRef.current = null;
    }
  }, []);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cdt.sound.v1") !== "0";
    } catch {
      return true;
    }
  });
  /**
   * Список станций тюнера из сценария (редактор «Радиостанции и подключения»).
   * Без поля в сценарии — весь каталог, поэтому старые заезды ведут себя как раньше.
   */
  // Источник истины — мир текущего заезда (для сценариев он собирается из customDef, для встроенных — каталог)
  // Смена машины в сценарии пересаживает игрока сразу: пересобирается кузов по паспорту
  // (габариты, база, колея, цвет) и пересчитывается кадр салона — без перезагрузки мира.
  useEffect(() => {
    const carId = scenarioId === "custom" ? customDef.playerCarId : undefined;
    sceneCtrlRef.current?.setPlayerCarModel(carId);
  }, [scenarioId, customDef.playerCarId]);

  const radioStations = useMemo(
    () => (scenarioId === "custom" ? radioStationsFor(customDef.radioStationIds) : [...RADIO_STATIONS]),
    [scenarioId, customDef.radioStationIds]
  );
  const radioStationsRef = useRef(radioStations);
  radioStationsRef.current = radioStations;

  // Действующий список отдаём в ШГУ (canvas рисует ту же станцию, что играет поток)
  useEffect(() => {
    setActiveRadioStations(radioStations);
    setHeadUnit((prev) =>
      prev.stationIndex < radioStations.length ? prev : { ...prev, stationIndex: 0, radioPlaying: false }
    );
  }, [radioStations]);

  const soundEnabledRef = useRef(soundEnabled);
  /** Отдельные слои звука: ДВС с шинами, клаксон, реле поворотника. */
  const [soundLayers, setSoundLayers] = useState<{ engine: boolean; horn: boolean; indicator: boolean }>(() => {
    try {
      const raw = localStorage.getItem("cdt.soundLayers.v1");
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ engine: boolean; horn: boolean; indicator: boolean }>;
        return { engine: p.engine !== false, horn: p.horn !== false, indicator: p.indicator !== false };
      }
    } catch {
      // storage blocked
    }
    return { engine: true, horn: true, indicator: true };
  });
  const soundLayersRef = useRef(soundLayers);
  soundLayersRef.current = soundLayers;

  /** Выключатель слоя звука (ДВС / сигнал / реле) с сохранением выбора в localStorage. */
  const toggleSoundLayer = useCallback(
    (layer: "engine" | "horn" | "indicator") => {
      setSoundLayers((prev) => {
        const next = { ...prev, [layer]: !prev[layer] };
        try {
          localStorage.setItem("cdt.soundLayers.v1", JSON.stringify(next));
        } catch {
          // storage blocked
        }
        engineSoundRef.current?.setLayers(next);
        const name = layer === "engine" ? "ДВС и шины" : layer === "horn" ? "Сигнал" : "Реле поворотника";
        onNotify(next[layer] ? `${name}: звук включён` : `${name}: звук выключен`);
        return next;
      });
    },
    [onNotify]
  );

  // Аудиограф создаётся по первому пользовательскому жесту: до него браузер всё равно не даст звук
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    try {
      localStorage.setItem("cdt.sound.v1", soundEnabled ? "1" : "0");
    } catch {
      // storage blocked
    }
    engineSoundRef.current?.setEnabled(soundEnabled);
    engineSoundRef.current?.setLayers(soundLayersRef.current);
    const kick = () => {
      if (soundEnabledRef.current) engineSoundRef.current?.ensureStarted();
    };
    window.addEventListener("pointerdown", kick, { once: true });
    window.addEventListener("keydown", kick, { once: true });
    return () => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
  }, [soundEnabled]);

  useEffect(() => {
    return () => {
      engineSoundRef.current?.dispose();
      engineSoundRef.current = null;
    };
  }, []);

  // Тон ДВС и шум шин обновляются каждым кадром из живого состояния ядра (0 работы без звука)
  const lastEngineSoundAtRef = useRef(0);
  const pushEngineSound = useCallback((s: SimState, throttle: number) => {
    if (!soundEnabledRef.current) return;
    const nowMs = performance.now();
    if (nowMs - lastEngineSoundAtRef.current < 55) return;
    lastEngineSoundAtRef.current = nowMs;
    let engine = engineSoundRef.current;
    if (!engine) {
      engine = new EngineSound();
      engine.setVolume(0.5);
      engine.setEnabled(true);
      engine.setLayers(soundLayersRef.current);
      engineSoundRef.current = engine;
    }
    engine.update({
      engineOn: s.engineOn,
      rpm: s.rpm,
      throttle,
      speedKmh: Math.abs(s.v) * 3.6,
      horn: s.horn === true,
    });
  }, []);

  // Щелчок реле поворотника на переднем фронте фазы мигания (~1,5 Гц, как настоящий прерыватель)
  const indicatorPhaseRef = useRef<number | null>(null);
  const pushIndicatorClick = useCallback(() => {
    const inp = inputRef.current;
    if (!inp.signal || !soundEnabledRef.current) {
      indicatorPhaseRef.current = null;
      return;
    }
    const phase = Math.floor((stateRef.current.time * 1000) / 667) % 2;
    if (phase === 0 && indicatorPhaseRef.current !== 0) engineSoundRef.current?.clickIndicator();
    indicatorPhaseRef.current = phase;
  }, []);

  // Сохранение настроек ШГУ и передача состояния в 3D-сцену (экран, шайбы, подсветка)
  useEffect(() => {
    headUnitRef.current = headUnit;
    saveHeadUnit(headUnit);
    sceneCtrlRef.current?.setHeadUnitState(headUnit);
  }, [headUnit]);

  /** Обрабатывает нажатие на интерактивный орган 3D-салона (ШГУ, VOL/TUNE, аварийка, START/STOP, свет, подрулевой, ручник). */
  const pressCockpitControl = useCallback(
    (id: CockpitControlId) => {
      const inp = inputRef.current;
      sceneCtrlRef.current?.setCockpitControlInteraction(null, id);
      switch (id) {
        case "headunit":
          cycleHeadUnitMode();
          break;
        case "vol":
          toggleRadioPlay();
          break;
        case "tune":
          stepRadioStation(1);
          break;
        case "hazard":
          setTurnSignal(inp.signal === "hazard" ? null : "hazard");
          break;
        case "start":
          toggleEngine();
          break;
        case "headlight":
          inp.lights = !inp.lights;
          onNotify(inp.lights ? "Ближний свет включён" : "Ближний свет выключен");
          break;
        case "stalk-left":
          setTurnSignal(inp.signal === null ? "left" : inp.signal === "left" ? "right" : null);
          break;
        case "handbrake":
          inp.handbrake = !inp.handbrake;
          onNotify(inp.handbrake ? "Стояночный тормоз затянут" : "Стояночный тормоз снят");
          break;
        case "horn": {
          // Клик по накладке руля — короткий сигнал (0,6 с), как «би-бип» в городе
          pressHorn(true);
          onNotify("Сигнал: би-бип!");
          break;
        }
      }
    },
    [cycleHeadUnitMode, onNotify, setTurnSignal, stepRadioStation, toggleEngine, toggleRadioPlay, pressHorn]
  );

  // Экшен-функции для цикла симуляции через ref (loop не пересоздаётся при их изменении)
  useEffect(() => {
    actionsRef.current = { toggleEngine, setGear, setTurnSignal };
  }, [toggleEngine, setGear, setTurnSignal]);

  /**
   * Отладочный мост для Playwright-смоука: экранные координаты органов салона и состояние ШГУ.
   * Не влияет на управление — только чтение/проекция, поэтому не участвует в детерминизме ядра.
   */
  useEffect(() => {
    const api = {
      headUnit: () => headUnitRef.current,
      controlPoint: (id: CockpitControlId) =>
        sceneCtrlRef.current?.getCockpitControlScreenPoint(id) ?? null,
      shifterPoint: (id: ShifterHitId) => sceneCtrlRef.current?.getShifterTargetScreenPoint(id) ?? null,
      pickAt: (normX: number, normY: number) => ({
        control: sceneCtrlRef.current?.pickCockpitControl(normX, normY) ?? null,
        shifter: sceneCtrlRef.current?.pickCockpitShifter(normX, normY) ?? null,
      }),
      shifterDragPoint: (id: Exclude<ShifterHitId, "lever">) => {
        const drag = shifterDragRef.current;
        return drag ? sceneCtrlRef.current?.getShifterDragTargetScreenPoint(id, drag.offsetX, drag.offsetZ) ?? null : null;
      },
      pressControl: (id: CockpitControlId) => pressCockpitControl(id),
      cameraMode: () => optsRef.current.cameraMode,
      gear: () => inputRef.current.gear,
      engineOn: () => inputRef.current.engineOn,
      signal: () => inputRef.current.signal,
      /** Досела ли шея: смоук ждёт этого вместо пауз — иначе экранные точки органов «плывут». */
      headSettled: () => sceneCtrlRef.current?.isHeadSettled() ?? true,
      /** Взгляд водителя: текущий детент и фактический угол головы (с инерцией шеи). */
      look: () => ({
        detent: sceneCtrlRef.current?.getHeadDetent() ?? 0,
        yawDeg: sceneCtrlRef.current?.getHeadYawDeg() ?? 0,
      }),
      /** Живое состояние ядра (для смоук-проверок: сигнал, передача, скорость). */
      state: () => stateRef.current,
      setHeadDetent: (detent: -1 | 0 | 1) => {
        sceneCtrlRef.current?.setHeadDetent(detent);
        setHeadDetentUi(detent === 0 ? "road" : detent > 0 ? "left" : "right");
      },
      audio: () => ({
        enabled: soundEnabledRef.current,
        engineCreated: Boolean(engineSoundRef.current),
        context: (() => {
          try {
            const audio = audioElRef.current;
            return audio ? { src: audio.src ? audio.src.slice(0, 120) : "", paused: audio.paused, volume: audio.volume } : null;
          } catch {
            return null;
          }
        })(),
      }),
      vehicle: () => ({
        gear: inputRef.current.gear,
        engineOn: inputRef.current.engineOn,
        signal: inputRef.current.signal,
        lights: inputRef.current.lights,
        handbrake: inputRef.current.handbrake,
        speedKmh: Math.round(Math.abs(stateRef.current.v) * 3.6),
      }),
    };
    (window as unknown as { __cdtCockpit?: typeof api }).__cdtCockpit = api;
    return () => {
      delete (window as unknown as { __cdtCockpit?: typeof api }).__cdtCockpit;
    };
  }, [pressCockpitControl]);

  const resetAttempt = useCallback(
    (targetWorld: WorldData, useReady: boolean) => {
      const defGear: Gear = defaultGearForWorld(targetWorld);
      const initState = createInitialState(targetWorld, useReady, calRef.current.maxInnerWheelDeg);
      stateRef.current = initState;
      inputRef.current = useReady ? createReadyInput(defGear) : createInitialInput();
      gridRef.current = new SpatialGrid(targetWorld.obstacles, 10);
      recorderRef.current = new AttemptRecorder(initState, useReady);
      latestViolationRef.current = null;
      autoSavedRef.current = false;
      rideDirtyRef.current = false;
      recordingActiveRef.current = true;
      keysRef.current = {};
      releasePedals();
      sceneCtrlRef.current?.resetOrbit();
      setHud((prev) => ({
        ...prev,
        state: initState,
        evalRes: evaluateAttempt([], 0, ruleRef.current),
        speedLimit: targetWorld.defaultSpeedLimitKmh,
        totalObstacles: targetWorld.obstacles.length,
        latestViolation: null,
      }));
    },
    [releasePedals]
  );

  // Перезагрузка мира при смене сценария, калибровки или OSM-файла
  useEffect(() => {
    worldRef.current = world;
    sceneCtrlRef.current?.loadWorld(world);
    resetAttempt(world, COLD_START);
  }, [world, resetAttempt, calibration.maxParkSpeedKmh, calibration.holdDurationSec, calibration.showLearnerSign]);

  // === [SEC:sim-loop] Three.js, главный цикл с фиксированным шагом 1/60 с и запись заезда ===
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = containerRef.current;
    if (!canvas || !box) return;

    let ctrl: SceneController | null = null;
    try {
      ctrl = new SceneController(canvas);
      ctrl.applyQuality(optsRef.current.quality);
      ctrl.loadWorld(worldRef.current);
      // Кузов и кадр водителя — по паспорту машины сценария, а не в общий «Ceed-кадр»
      ctrl.setPlayerCarModel(worldRef.current.playerCarId);
      ctrl.resize(box.clientWidth, box.clientHeight);
      sceneCtrlRef.current = ctrl;
      setWebglFallback(false);
    } catch {
      sceneCtrlRef.current = null;
      setWebglFallback(true);
    }

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      if (sceneCtrlRef.current) {
        sceneCtrlRef.current.resize(r.width, r.height);
      } else if (canvasRef.current) {
        canvasRef.current.width = Math.max(320, Math.floor(r.width));
        canvasRef.current.height = Math.max(240, Math.floor(r.height));
      }
    });
    ro.observe(box);

    let rafId = 0;
    let lastMs = performance.now();
    let accumulator = 0;
    let lastHudUpdate = 0;
    let lastGridChecks = 0;
    let lastLimit = worldRef.current.defaultSpeedLimitKmh;

    const frame = (nowMs: number) => {
      // Скрытый тренажёр не рендерит и не считает физику, но состояние заезда сохраняется.
      // lastMs переставляется, чтобы после возврата не «проглотить» время паузы
      if (!activeRef.current) {
        lastMs = nowMs;
        accumulator = 0;
        rafId = requestAnimationFrame(frame);
        return;
      }
      const frameDelta = Math.min((nowMs - lastMs) / 1000, 0.1);
      lastMs = nowMs;
      accumulator += frameDelta;

      const keys = keysRef.current;
      const inp = inputRef.current;
      const newEventsBatch: SimEvent[] = [];

      // USB-устройство опрашивается раз в кадр и только если оно включено в профиле
      const padProfileNow = padProfileRef.current;
      const padSnap = padProfileNow.enabled ? readBrowserGamepad(padProfileNow.deviceId) : null;
      updateAxisArming(padArmingRef.current, padSnap);
      const pad = readGamepad(padSnap, padProfileNow, padArmingRef.current);
      if (pad.active) {
        const prev = prevPadButtonsRef.current;
        const edge = (key: keyof typeof pad.buttons) => Boolean(pad.buttons[key] && !prev[key]);
        const actions = actionsRef.current;
        if (actions) {
          if (edge("engine")) actions.toggleEngine();
          if (edge("handbrake")) inp.handbrake = !inp.handbrake;
          if (edge("signalLeft")) actions.setTurnSignal(inp.signal === "left" ? null : "left");
          if (edge("signalRight")) actions.setTurnSignal(inp.signal === "right" ? null : "right");
          if (edge("gearDrive")) actions.setGear("D");
          if (edge("gearReverse")) actions.setGear("R");
        }
        prevPadButtonsRef.current = { ...pad.buttons };
      } else {
        prevPadButtonsRef.current = {};
      }

      // Фиксированный шаг 1/60 с (детерминированное ядро)
      while (accumulator >= FIXED_DT) {
        const gasPressed = Boolean(keys.KeyW || touchPedalRef.current.gas);
        const brakePressed = Boolean(keys.KeyS || touchPedalRef.current.brake);
        keyboardThrottleRef.current = advanceKeyboardThrottle(
          keyboardThrottleRef.current, gasPressed, Boolean(keys.ShiftLeft || keys.ShiftRight), FIXED_DT
        );
        inp.throttle = Math.max(keyboardThrottleRef.current, pad.throttle);
        inp.brake = Math.max(brakePressed ? 1 : 0, pad.brake);
        // Shift вместе с тормозом = энергичное нажатие: быстрый набор давления и +18 % замедления
        inp.shiftBoost = Boolean((keys.ShiftLeft || keys.ShiftRight) && inp.brake > 0.05);
        // Сигнал: клавиша H, кнопка на руле в кабине (короткий би-бип) или кнопка геймпада (удержание).
        // Единый источник — hornHeldRef, чтобы таймер короткого сигнала не гасил нажатый H.
        inp.horn = Boolean(keys.KeyH || pad.buttons.horn || hornHeldRef.current);

        // Руль: отклонённое USB-устройство перехватывает управление у клавиатуры
        // A/D — руль; ←/→ — переключение точек внимания (зеркало/дорога), они не крутят руль
        const steerL = Boolean(keys.KeyA);
        const steerR = Boolean(keys.KeyD);
        if (pad.steering) {
          inp.steerWheelDeg = pad.steerWheelDeg;
        } else if (steerL && !steerR) {
          inp.steerWheelDeg = clamp(
            inp.steerWheelDeg + steerRateRef.current * FIXED_DT,
            -STEER_WHEEL.maxDeg,
            STEER_WHEEL.maxDeg
          );
        } else if (steerR && !steerL) {
          inp.steerWheelDeg = clamp(
            inp.steerWheelDeg - steerRateRef.current * FIXED_DT,
            -STEER_WHEEL.maxDeg,
            STEER_WHEEL.maxDeg
          );
        } else if (!holdingSteerRef.current && Math.abs(stateRef.current.v) > 0.25) {
          // Плавное самоцентрирование на ходу, только пока руль не удерживают мышью/пальцем (п. 2.1)
          const returnStep =
            STEER_WHEEL.selfCenterRate * clamp(Math.abs(stateRef.current.v) / 4.5, 0.2, 1.2) * FIXED_DT;
          if (Math.abs(inp.steerWheelDeg) <= returnStep) inp.steerWheelDeg = 0;
          else inp.steerWheelDeg -= Math.sign(inp.steerWheelDeg) * returnStep;
        }

        // Защита от заглохания в ручном режиме M2..M6 (Shiftronic): при торможении или остановке
        // передача мягко сбрасывается вниз до записи тика — реплей остаётся побитно идентичным.
        if (isManualGear(inp.gear)) {
          const g = Number(inp.gear);
          const curV = stateRef.current.v;
          const prevV = stateRef.current.prevV;
          const fwdKmh = Math.max(0, curV * 3.6);
          if (g > 1 && prevV > 0.05 && curV <= 0.05) {
            inp.gear = "1";
          } else if (g > 1 && inp.brake > 0.15 && fwdKmh < MANUAL_STALL_DOWN_KMH[g]) {
            inp.gear = String(g - 1) as Gear;
          }
        }

        // Ядро и запись получают одни и те же значения ввода — иначе реплей расходится с заездом
        quantizeInput(inp);

        const out = stepSimulation(
          stateRef.current,
          inp,
          worldRef.current,
          gridRef.current,
          calRef.current,
          ruleRef.current,
          FIXED_DT
        );
        stateRef.current = out.state;
        lastGridChecks = out.gridChecks;
        lastLimit = out.activeSpeedLimitKmh;
        // После закрытия попытки ввод не пишется: следующий заезд начинается по «Сброс»
        if (recordingActiveRef.current) {
          recorderRef.current.recordTick(inp, out.state, out.newEvents);
          rideDirtyRef.current = true;
        }
        if (out.newEvents.length) newEventsBatch.push(...out.newEvents);
        accumulator -= FIXED_DT;
      }

      if (newEventsBatch.length > 0) {
        const lastEv = newEventsBatch[newEventsBatch.length - 1];
        const rule = ruleRef.current.rules.find((r) => r.code === lastEv.code && r.enabled);
        if (rule) {
          latestViolationRef.current = {
            title: rule.title,
            points: rule.points,
            detail: lastEv.detail,
            at: nowMs,
          };
        }
      }

      // Автосохранение завершённой попытки в журнал
      if (stateRef.current.finished && !autoSavedRef.current) {
        autoSavedRef.current = true;
        const snap = recorderRef.current.snapshot(
          stateRef.current,
          worldRef.current,
          calRef.current,
          ruleRef.current
        );
        attemptSavedRef.current(snap, false);
        rideDirtyRef.current = false;
        recordingActiveRef.current = false;
      }

      // Руль в SVG поворачиваем напрямую каждым кадром (без задержки React-состояния)
      if (wheelGroupRef.current) {
        wheelGroupRef.current.setAttribute("transform", `rotate(${-stateRef.current.swDeg} 50 50)`);
      }

      pushIndicatorClick();

      // Процедурный звук ДВС и шин из живого состояния (не чаще ~18 Гц, без работы при выключенном звуке)
      pushEngineSound(stateRef.current, inp.throttle);

      // Отрисовка 3D или 2D-фолбэка
      const isBraking = inp.brake > 0.05;
      if (sceneCtrlRef.current) {
        sceneCtrlRef.current.render(stateRef.current, worldRef.current, isBraking, optsRef.current, {
          rear: rearMirrorRef.current,
          left: leftMirrorRef.current,
          right: rightMirrorRef.current,
        });
      } else if (canvasRef.current) {
        render2DFallback(canvasRef.current, stateRef.current, worldRef.current);
      }

      // Обновление React HUD ~12 раз в секунду
      if (nowMs - lastHudUpdate > 82) {
        lastHudUpdate = nowMs;
        const s = stateRef.current;
        const w = worldRef.current;
        const evalRes = evaluateAttempt(recorderRef.current.getEvents(), s.collisions, ruleRef.current);

        // Ближайший попутный светофор впереди (до 45 м)
        let nextSignal: HudSnapshot["nextSignal"] = null;
        let bestDist = 48;
        for (const sig of w.signals) {
          if (Math.cos(s.h - sig.h) < 0.55) continue;
          const d = Math.hypot(sig.stopLineX - s.x, sig.stopLineZ - s.z);
          const ahead =
            (sig.stopLineX - s.x) * Math.sin(sig.h) + (sig.stopLineZ - s.z) * Math.cos(sig.h);
          if (ahead > -2 && d < bestDist) {
            bestDist = d;
            const ph = getTrafficLightPhase(sig, s.time);
            nextSignal = { phase: ph.phase, sec: Math.ceil(ph.remainingSec), forbidden: ph.isForbidden };
          }
        }

        const viol =
          latestViolationRef.current && nowMs - latestViolationRef.current.at < 4600
            ? latestViolationRef.current
            : null;

        setHud({
          state: { ...s },
          evalRes,
          speedLimit: lastLimit,
          gridChecks: lastGridChecks,
          totalObstacles: w.obstacles.length,
          perf: sceneCtrlRef.current
            ? sceneCtrlRef.current.getPerfMetrics()
            : { fps: 60, p95FrameMs: 16, visibleBuildings: 0, totalBuildings: 0 },
          nextSignal,
          latestViolation: viol,
        });
      }

      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      ctrl?.dispose();
      sceneCtrlRef.current = null;
    };
    // Сцена создаётся один раз; актуальные колбэки берутся из ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === [SEC:sim-keyboard] Горячие клавиши и защита от залипания при потере фокуса ===
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!activeRef.current || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      // Слайдеру оставляем стрелки, Home и End. Клавиши вождения и Shift работают и после настройки.
      const drivingFromSlider =
        e.target instanceof HTMLInputElement &&
        e.target.type === "range" &&
        (/^Key[A-Z]$/.test(e.code) || e.code === "ShiftLeft" || e.code === "ShiftRight");
      if (isEditable(e.target) && !drivingFromSlider) return;
      const code = logicalKey(bindingsRef.current, e.code);
      if (code === "unbound") return;
      // Любая назначенная клавиша принадлежит только управлению. В частности, физический
      // Space после переназначения не должен ещё и активировать сфокусированную HTML-кнопку.
      e.preventDefault();
      if (e.repeat) return; // повтор после захвата клавиши в настройках не должен включать педаль
      const alreadyHeld = keysRef.current[code];
      keysRef.current[code] = true;
      if (alreadyHeld) return;

      const inp = inputRef.current;
      // ←/→ — три точки внимания водителя: левое зеркало → дорога (+ салонное зеркало) → правое.
      // Шаг дискретный, на каждое нажатие; довод идёт с инерцией шеи в кадре (sceneController).
      if (code === "ArrowLeft" || code === "ArrowRight") {
        const ctrl = sceneCtrlRef.current;
        if (ctrl) {
          const detent = ctrl.stepHeadDetent(code === "ArrowLeft" ? 1 : -1);
          setHeadDetentUi(detent === 0 ? "road" : detent > 0 ? "left" : "right");
          onNotify(`Взгляд: ${detentLabel(detent)}`);
        }
        return;
      }
      switch (code) {
        case "KeyI":
          toggleEngine();
          break;
        case "Space":
          inp.handbrake = !inp.handbrake;
          break;
        case "KeyB":
          inp.belt = !inp.belt;
          break;
        case "KeyL":
          inp.lights = !inp.lights;
          break;
        case "KeyQ":
          // Инвариант №3: Q — левый поворотник (+X)
          setTurnSignal(inp.signal === "left" ? null : "left");
          break;
        case "KeyE":
          // Инвариант №3: E — правый поворотник (-X)
          setTurnSignal(inp.signal === "right" ? null : "right");
          break;
        case "KeyZ":
          setTurnSignal(inp.signal === "hazard" ? null : "hazard");
          break;
        case "KeyP":
          setGear("P");
          break;
        case "KeyR":
          setGear("R");
          break;
        case "KeyN":
          setGear("N");
          break;
        case "KeyF":
          setGear("D");
          break;
        case "ArrowUp":
        case "ArrowDown": {
          const st = stateRef.current;
          const { next, blockedReason } = stepKeyboardGear(
            { ...inp, brake: liveBrakePressure() }, st.v, st.autoSubGear,
            code === "ArrowUp" ? 1 : -1, Boolean(keysRef.current.ShiftLeft || keysRef.current.ShiftRight)
          );
          if (blockedReason) onNotify(blockedReason);
          else if (next) setGear(next);
          break;
        }
        case "ShiftLeft":
        case "ShiftRight":
          // Сам Shift не меняет передачу: модификатор ручного переключения/педалей.
          break;
        case "KeyH":
          // H — сигнал (клаксон): удерживаем, как настоящий подрулевой штурвал
          pressHorn(false);
          break;
        case "KeyV":
          setUiHidden((hidden) => !hidden);
          break;
        case "KeyO":
          setControlsCollapsed(false);
          setShowControls((shown) => !shown);
          break;
        case "KeyU":
          // Та же команда, что у кнопки: полноэкранная сцена, а не только скрытие HUD.
          e.preventDefault();
          if (immersive) leaveImmersive();
          else enterImmersive();
          break;
        case "KeyC":
          setCameraMode((prev) => {
            const order: CameraMode[] = ["chase", "cockpit", "top", "orbit"];
            return order[(order.indexOf(prev) + 1) % order.length];
          });
          break;
        case "Digit1":
          setCameraMode("chase");
          break;
        case "Digit2":
          setCameraMode("cockpit");
          break;
        case "Digit3":
          setCameraMode("top");
          break;
        case "Digit4":
          setCameraMode("orbit");
          break;
        case "KeyG":
          toggleShifterGlance();
          break;
        case "Backspace":
          e.preventDefault();
          resetAttempt(worldRef.current, COLD_START);
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const code = logicalKey(bindingsRef.current, e.code);
      keysRef.current[code] = false;
      if (code === "KeyH") releaseHorn();
    };

    const onBlur = () => {
      keysRef.current = {};
      releasePedals();
      releaseHorn();
      holdingSteerRef.current = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    resetAttempt,
    releasePedals,
    setTurnSignal,
    setGear,
    shiftGear,
    liveBrakePressure,
    toggleEngine,
    toggleShifterGlance,
    immersive,
    enterImmersive,
    leaveImmersive,
    onNotify,
    pressHorn,
    releaseHorn,
  ]);

  // === [SEC:sim-pointer] Мышь на холсте, 3D-рычаг АКПП в салоне, экранный руль, педали и импорт OSM ===
  // Инвариант #12: ЛКМ — руль (вправо уменьшает swDeg; при захвате 3D-рычага АКПП — кулиса), ПКМ — орбита, колесо — зум.
  const pointerDragRef = useRef<{ id: number; btn: number; lastX: number; lastY: number } | null>(null);
  const shifterHoverRef = useRef<ShifterHitId | null>(null);
  const shifterDragRef = useRef<{
    id: number;
    initialHit: ShifterHitId;
    startClientX: number;
    startClientY: number;
    moved: boolean;
    offsetX: number;
    offsetZ: number;
    gateZ: number;
    /** Точка X входа в паз D — защищает от случайного срыва в боковой паз M при прямом ходе P→R→N→D. */
    dAnchorX: number | null;
    /** Точка (X, Z) входа в ручной паз M — задаёт точный центр качания +/− и возврата вправо M→D. */
    mAnchorX: number | null;
    mAnchorZ: number | null;
    /** Пружинный фиксатор качания рычага вперёд `+` / назад `−` в ручном пазу Shiftronic. */
    manualLatch: -1 | 0 | 1;
  } | null>(null);

  const readCanvasNorm = (canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      normX: (clientX - rect.left) / rect.width,
      normY: (clientY - rect.top) / rect.height,
      localX: clientX - rect.left,
      localY: clientY - rect.top,
    };
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1) {
      e.preventDefault(); // средняя кнопка не включает педали и не запускает автоскролл
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    // В режиме салона ЛКМ по органам (ШГУ, VOL/TUNE, аварийка, START/STOP, свет, подрулевой, ручник) нажимает их
    const ctrl = sceneCtrlRef.current;
    if (e.button === 0 && ctrl && optsRef.current.cameraMode === "cockpit") {
      const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
      const control = pos ? ctrl.pickCockpitControl(pos.normX, pos.normY) : null;
      if (control) {
        e.preventDefault();
        pressCockpitControl(control);
        setCockpitControlUi({ id: control, x: pos!.localX, y: pos!.localY });
        return;
      }
      const hit = pos ? ctrl.pickCockpitShifter(pos.normX, pos.normY) : null;
      if (pos && hit) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const anchor = ctrl.getShifterLocalAnchor();
        const planeHit = ctrl.projectToShifterLocal(pos.normX, pos.normY);
        const offsetX = planeHit ? planeHit.x - anchor.leverX : 0;
        const offsetZ = planeHit ? planeHit.z - anchor.leverZ : 0;
        const curGear = inputRef.current.gear;
        shifterDragRef.current = {
          id: e.pointerId,
          initialHit: hit,
          startClientX: e.clientX,
          startClientY: e.clientY,
          moved: false,
          offsetX,
          offsetZ,
          gateZ: anchor.gateZ,
          dAnchorX: curGear === "D" ? SHIFTER_LAYOUT.mainRailX : null,
          mAnchorX: isManualGear(curGear) ? SHIFTER_LAYOUT.manualRailX : null,
          mAnchorZ: isManualGear(curGear) ? SHIFTER_LAYOUT.offD : null,
          manualLatch: 0,
        };
        shifterHoverRef.current = hit;
        ctrl.setShifterInteraction(hit, true, 0);
        setCockpitShifterUi({ hit, dragging: true, x: pos.localX, y: pos.localY });
        return;
      }
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    pointerDragRef.current = { id: e.pointerId, btn: e.button, lastX: e.clientX, lastY: e.clientY };
    if (e.button === 0) holdingSteerRef.current = true;
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctrl = sceneCtrlRef.current;

    // 1. Активное перетаскивание 3D-рычага АКПП по H/L-образной кулисе P–R–N–D | +M−
    const sDrag = shifterDragRef.current;
    if (sDrag && sDrag.id === e.pointerId) {
      const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
      if (!pos || !ctrl) return;
      if (!sDrag.moved && Math.hypot(e.clientX - sDrag.startClientX, e.clientY - sDrag.startClientY) >= 5) {
        sDrag.moved = true;
      }
      if (!sDrag.moved) {
        setCockpitShifterUi({ hit: sDrag.initialHit, dragging: true, x: pos.localX, y: pos.localY });
        return;
      }
      const planeHit = ctrl.projectToShifterLocal(pos.normX, pos.normY);
      if (!planeHit) return;
      const relX = planeHit.x - sDrag.offsetX;
      const dz = planeHit.z - sDrag.offsetZ - sDrag.gateZ;
      const curGear = inputRef.current.gear;
      let activeBadge: ShifterHitId = "lever";

      if (isManualGear(curGear)) {
        const mRefX = sDrag.mAnchorX ?? SHIFTER_LAYOUT.manualRailX;
        const mRefZ = sDrag.mAnchorZ ?? SHIFTER_LAYOUT.offD;
        const mDelta = dz - mRefZ;
        // Поперечная перемычка M → D открыта в средней зоне паза (при ходе вверх/вниз к +/− держит стенка кулисы)
        if (relX <= mRefX - 0.021 && Math.abs(mDelta) < 0.032) {
          const switched = engageCockpitShifter("D", { fromDrag: true });
          sDrag.manualLatch = 0;
          sDrag.mAnchorX = null;
          sDrag.mAnchorZ = null;
          ctrl.setShifterInteraction("D", true, 0);
          activeBadge = "D";
          if (switched === "D") {
            sDrag.dAnchorX = relX;
          }
        } else if (mDelta >= 0.02) {
          // Пружинное качание рычага вперёд (+) — повышение ступени M1..M6
          if (sDrag.manualLatch !== 1) {
            sDrag.manualLatch = 1;
            engageCockpitShifter("M+", { fromDrag: true });
          }
          ctrl.setShifterInteraction("M+", true, 1);
          activeBadge = "M+";
        } else if (mDelta <= -0.02) {
          // Пружинное качание рычага назад (−) — понижение ступени M6..M1
          if (sDrag.manualLatch !== -1) {
            sDrag.manualLatch = -1;
            engageCockpitShifter("M-", { fromDrag: true });
          }
          ctrl.setShifterInteraction("M-", true, -1);
          activeBadge = "M-";
        } else {
          if (Math.abs(mDelta) < 0.011) sDrag.manualLatch = 0;
          ctrl.setShifterInteraction("M", true, 0);
          activeBadge = "M";
        }
      } else {
        // Из положения D боковой ход влево (к водителю) переводит рычаг через перемычку в паз Shiftronic M
        let enteredManual = false;
        if (curGear === "D") {
          if (sDrag.dAnchorX === null) sDrag.dAnchorX = relX;
          if (relX - sDrag.dAnchorX >= 0.021 && dz < -0.008 && dz > -0.11) {
            const switched = engageCockpitShifter("M", { fromDrag: true });
            if (switched) {
              sDrag.manualLatch = 0;
              sDrag.dAnchorX = null;
              sDrag.mAnchorX = relX;
              sDrag.mAnchorZ = dz;
              activeBadge = "M";
              enteredManual = true;
            }
          } else {
            sDrag.dAnchorX = Math.min(sDrag.dAnchorX, Math.max(relX, SHIFTER_LAYOUT.mainRailX));
          }
        }
        if (!enteredManual) {
          // Продольный ход по основной прорези P (+0.058) ↔ R (+0.022) ↔ N (-0.014) ↔ D (-0.050)
          const targetMain: "P" | "R" | "N" | "D" =
            dz >= 0.04 ? "P" : dz >= 0.004 ? "R" : dz >= -0.032 ? "N" : "D";
          if (targetMain !== curGear) {
            const switched = engageCockpitShifter(targetMain, { fromDrag: true });
            sDrag.dAnchorX = switched === "D" ? relX : null;
            sDrag.mAnchorX = null;
            sDrag.mAnchorZ = null;
            activeBadge = targetMain;
          } else {
            if (curGear !== "D") {
              sDrag.dAnchorX = null;
              sDrag.mAnchorX = null;
              sDrag.mAnchorZ = null;
            }
            activeBadge = curGear;
          }
        }
        ctrl.setShifterInteraction(activeBadge, true, 0);
      }

      setCockpitShifterUi({ hit: activeBadge, dragging: true, x: pos.localX, y: pos.localY });
      return;
    }

    // 2. Вращение руля (ЛКМ) или обзор камеры/головы (ПКМ)
    const drag = pointerDragRef.current;
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (drag.btn === 0) {
        // Инвариант №6: движение мыши вправо уменьшает swDeg (поворот вправо)
        inputRef.current.steerWheelDeg = clamp(
          inputRef.current.steerWheelDeg - dx * 2.1,
          -STEER_WHEEL.maxDeg,
          STEER_WHEEL.maxDeg
        );
      } else if (drag.btn === 2 && ctrl) {
        ctrl.adjustOrbit(dx, dy);
        if (optsRef.current.cameraMode === "cockpit") {
          setShifterGlance(ctrl.isCockpitShifterView());
        }
      }
      return;
    }

    // 3. Свободное наведение курсора в салоне: сначала органы ШГУ/света/стартера, затем 3D-рычаг АКПП
    if (ctrl && optsRef.current.cameraMode === "cockpit") {
      const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
      const control = pos ? ctrl.pickCockpitControl(pos.normX, pos.normY) : null;
      if (pos && control) {
        ctrl.setCockpitControlInteraction(control);
        setCockpitControlUi({ id: control, x: pos.localX, y: pos.localY });
        if (shifterHoverRef.current !== null) {
          shifterHoverRef.current = null;
          ctrl.setShifterInteraction(null, false, 0);
          setCockpitShifterUi(null);
        }
        return;
      }
      ctrl.setCockpitControlInteraction(null);
      if (cockpitControlUi) setCockpitControlUi(null);
      const hit = pos ? ctrl.pickCockpitShifter(pos.normX, pos.normY) : null;
      if (pos && hit) {
        shifterHoverRef.current = hit;
        ctrl.setShifterInteraction(hit, false, 0);
        setCockpitShifterUi({ hit, dragging: false, x: pos.localX, y: pos.localY });
      } else if (shifterHoverRef.current !== null) {
        shifterHoverRef.current = null;
        ctrl.setShifterInteraction(null, false, 0);
        setCockpitShifterUi(null);
      }
    }
  };

  const handleCanvasPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sDrag = shifterDragRef.current;
    if (sDrag && sDrag.id === e.pointerId) {
      shifterDragRef.current = null;
      const ctrl = sceneCtrlRef.current;
      // Короткий клик без перетаскивания: по пазу P/R/N/D/M/+/− — точный выбор, по рукоятке — шаг по кулисе
      if (!sDrag.moved) {
        if (sDrag.initialHit === "lever") {
          if (inputRef.current.gear === "D") {
            engageCockpitShifter("M");
          } else if (isManualGear(inputRef.current.gear)) {
            engageCockpitShifter("D");
          } else {
            stepCockpitShifter(1);
          }
        } else {
          engageCockpitShifter(sDrag.initialHit, { toggleManualOnClick: sDrag.initialHit === "M" });
        }
      }
      if (ctrl && optsRef.current.cameraMode === "cockpit") {
        const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
        const hit = pos ? ctrl.pickCockpitShifter(pos.normX, pos.normY) : null;
        shifterHoverRef.current = hit;
        ctrl.setShifterInteraction(hit, false, 0);
        setCockpitShifterUi(pos && hit ? { hit, dragging: false, x: pos.localX, y: pos.localY } : null);
      } else {
        shifterHoverRef.current = null;
        ctrl?.setShifterInteraction(null, false, 0);
        setCockpitShifterUi(null);
      }
      return;
    }

    if (pointerDragRef.current?.id === e.pointerId) {
      if (pointerDragRef.current.btn === 0) holdingSteerRef.current = false;
      pointerDragRef.current = null;
    }
  };

  const handleCanvasPointerLeave = () => {
    sceneCtrlRef.current?.setCockpitControlInteraction(null);
    setCockpitControlUi(null);
    if (shifterDragRef.current) return;
    if (shifterHoverRef.current !== null) {
      shifterHoverRef.current = null;
      sceneCtrlRef.current?.setShifterInteraction(null, false, 0);
      setCockpitShifterUi(null);
    }
  };

  // Экранный SVG-руль (±540°, круговое вращение)
  const wheelAnglePrevRef = useRef<number | null>(null);
  const readPointerWheelAngle = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return (Math.atan2(e.clientY - (rect.top + rect.height / 2), e.clientX - (rect.left + rect.width / 2)) * 180) / Math.PI;
  };

  const handleWheelDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    wheelAnglePrevRef.current = readPointerWheelAngle(e);
    holdingSteerRef.current = true;
  };

  const handleWheelMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (wheelAnglePrevRef.current === null) return;
    const cur = readPointerWheelAngle(e);
    let diff = cur - wheelAnglePrevRef.current;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    wheelAnglePrevRef.current = cur;
    // По часовой стрелке на экране (diff > 0) = вправо => swDeg уменьшается
    inputRef.current.steerWheelDeg = clamp(
      inputRef.current.steerWheelDeg - diff,
      -STEER_WHEEL.maxDeg,
      STEER_WHEEL.maxDeg
    );
  };

  const handleWheelEnd = () => {
    wheelAnglePrevRef.current = null;
    holdingSteerRef.current = false;
  };

  // Захват рабочей поверхности и захват ручки переноса принадлежат разным DOM-элементам.
  // Отпускание второго пальца не сбрасывает педаль, удерживаемую первым.
  const pressPedal = (which: "gas" | "brake", owner: number) => {
    if (pedalOwner.current[which] !== null) return;
    pedalOwner.current[which] = owner;
    touchPedalRef.current[which] = true;
    setPedalVisual({ ...touchPedalRef.current });
  };
  const releasePedal = (which: "gas" | "brake", owner: number) => {
    if (pedalOwner.current[which] !== owner) return;
    pedalOwner.current[which] = null;
    touchPedalRef.current[which] = false;
    setPedalVisual({ ...touchPedalRef.current });
  };
  const bindPedal = (which: "gas" | "brake") => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || pedalOwner.current[which] !== null) return;
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      pressPedal(which, e.pointerId);
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => releasePedal(which, e.pointerId),
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => releasePedal(which, e.pointerId),
    onLostPointerCapture: (e: React.PointerEvent<HTMLButtonElement>) => releasePedal(which, e.pointerId),
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.code !== "Space" && e.code !== "Enter") return;
      e.preventDefault(); e.stopPropagation(); pressPedal(which, -1);
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.code !== "Space" && e.code !== "Enter") return;
      e.preventDefault(); e.stopPropagation(); releasePedal(which, -1);
    },
    onBlur: () => releasePedal(which, -1),
  });

  /** Явное действие ученика: переводит автомобиль из холодного старта P в рабочий режим. */
  const handleQuickStart = () => {
    const inp = inputRef.current;
    const targetGear: Gear = defaultGearForWorld(worldRef.current);
    inp.engineOn = true;
    inp.belt = true;
    inp.handbrake = false;
    inp.lights = true;
    inp.gear = targetGear;
    if (defaultGearForWorld(worldRef.current) === "D" && !stateRef.current.hasMoved) {
      inp.signal = "left";
    }
    setHud((current) => ({
      ...current,
      state: {
        ...current.state,
        engineOn: true,
        belt: true,
        handbrake: false,
        lights: true,
        gear: targetGear,
        signal: inp.signal,
      },
    }));
    onNotify(
      `Холодный старт завершён: КПП переведена из P в ${targetGear}. Удерживайте W (или ГАЗ), руль — A/D или мышью.`
    );
  };

  const handleFinishAndDebrief = () => {
    const snap = recorderRef.current.snapshot(
      stateRef.current,
      worldRef.current,
      calRef.current,
      ruleRef.current
    );
    onAttemptSaved(snap, true);
    recordingActiveRef.current = false;
    rideDirtyRef.current = false;
  };

  const handleOsmFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) {
      onNotify("Файл превышает лимит 30 МБ — уменьшите bbox выгрузки");
      return;
    }
    try {
      const text = await file.text();
      const { pack } = parseMapFileText(text, file.name);
      if (pack.roads.length === 0) {
        onNotify("В файле не найдено дорог с тегом highway");
        return;
      }
      setOsmRouteCandidate("");
      setOsmRouteReverse(false);
      setOsmBarClosed(false);
      setOsmBarCollapsed(false);
      onCustomOsmChange(pack, pack);
      onScenarioChange("city_osm");
      const check = checkScenarioRoute(customFromOsmPack(pack));
      if (check.status !== "valid") setShowOsmCheck(true);
      const spanX = Math.round(pack.bounds.maxX - pack.bounds.minX);
      const spanZ = Math.round(pack.bounds.maxZ - pack.bounds.minZ);
      const signsPart = pack.signs.length > 0 ? `, знаков ${pack.signs.length}` : "";
      const deconfPart =
        (pack.meta.resolvedConflictsCount ?? 0) > 0
          ? `, согласовано ${pack.meta.resolvedConflictsCount}`
          : "";
      onNotify(
        `Загружен OSM (${spanX}×${spanZ} м): дорог ${pack.meta.roadsCount}, КТ ${pack.routeCheckpoints.length}, светофоров ${pack.meta.signalsCount}${signsPart}${deconfPart}`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Ошибка разбора файла карты (.osm / JSON / GeoJSON)");
    }
  };

  // Проверка и варианты маршрута для загруженного пакета OSM прямо в 3D-тренажёре
  const osmRouteCheck = useMemo(() => {
    if (!customOsm || scenarioId !== "city_osm") return null;
    return checkScenarioRoute(customFromOsmPack(customOsm));
  }, [customOsm, scenarioId]);

  const osmCandidates = useMemo(() => {
    if (!customOsm || scenarioId !== "city_osm") return [];
    return listRouteCandidates(customOsm.roads, customOsm.boundaryPolygon);
  }, [customOsm, scenarioId]);

  const selectedOsmCandidate = useMemo(
    () => (osmRouteCandidate ? osmCandidates.find((c) => c.id === osmRouteCandidate) : osmCandidates[0]),
    [osmCandidates, osmRouteCandidate]
  );

  const applyOsmRouteVariant = (candidateId: string, reverse: boolean) => {
    if (!customOsm) return;
    const built = buildRouteFromRoads(customOsm.roads, {
      candidateId: candidateId || undefined,
      reverse,
      boundaryPolygon: customOsm.boundaryPolygon,
      obstacles: [...customOsm.buildings, ...(customOsm.extraObstacles ?? [])],
    });
    if (built.checkpoints.length === 0) {
      onNotify("По выбранной улице не удалось собрать контрольные точки");
      return;
    }
    const effectiveReverse = built.reverseBlocked ? false : reverse;
    setOsmRouteCandidate(candidateId);
    setOsmRouteReverse(effectiveReverse);
    onCustomOsmChange({
      ...customOsm,
      suggestedStart: built.startPose ?? customOsm.suggestedStart,
      routeCheckpoints: built.checkpoints,
      routeRoadName: built.roadName,
    });
    if (built.reverseBlocked) {
      onNotify(
        `«${built.roadName}» — односторонняя улица OSM: маршрут оставлен по разрешённому направлению (${built.checkpoints.length} КТ)`
      );
      return;
    }
    onNotify(
      `Маршрут перестроен: «${built.roadName}» (${built.checkpoints.length} КТ, ${Math.round(built.totalLengthM)} м${effectiveReverse ? ", реверс" : ""})`
    );
  };

  const applyOsmCorridorCrop = () => {
    if (!customOsm) return;
    const base = rawCustomOsm ?? customOsm;
    const spine =
      osmRouteCheck && osmRouteCheck.fullSpine.length >= 2
        ? osmRouteCheck.fullSpine
        : customOsm.routeCheckpoints.map((c) => ({ x: c.x, z: c.z }));
    const poly = buildRouteCorridorPolygon(spine, 30);
    if (poly.length < 3) {
      onNotify("Сначала выберите улицу маршрута для построения коридора");
      return;
    }
    const cropped = cropOsmPackToPolygon(base, poly);
    onCustomOsmChange(cropped, base);
    onNotify(
      `Карта обрезана по коридору маршрута (${poly.length} вершин, дорог: ${cropped.roads.length}, КТ: ${cropped.routeCheckpoints.length})`
    );
  };

  const fixOsmRouteInPlace = () => {
    if (!customOsm) return;
    const { def: fixed, fixes } = autoFixScenarioRoute(customFromOsmPack(customOsm));
    onCustomOsmChange({
      ...customOsm,
      suggestedStart: fixed.start,
      routeCheckpoints: fixed.checkpoints,
      bounds: fixed.bounds,
      boundaryPolygon: fixed.boundaryPolygon,
    });
    onNotify(fixes.length > 0 ? fixes[0] : "Маршрут уже корректен");
  };

  const s = hud.state;
  // Реальная улица под автомобилем — привязка HUD к маршруту OSM
  const street = useMemo(
    () => streetNameAt(s.x, s.z, world.roads, 18),
    [s.x, s.z, world.roads]
  );
  const kmh = Math.round(Math.abs(s.v) * 3.6);
  const manualMode = isManualGear(s.gear);
  const gearDisplay = formatGearLabel(s.gear, s.autoSubGear, s.engineOn);
  const shiftUpCue =
    s.engineOn && manualMode && Number(s.gear) < MAX_FORWARD_GEAR && s.rpm >= SHIFT_HINT_RPM;
  const { leftLit: leftBlink, rightLit: rightBlink } = getTurnSignalFlash(s.signal, s.time);
  const needsPrep = !s.engineOn || s.handbrake || !s.belt || s.gear === "P";

  return (
    <div className="space-y-2">
      {/* [SEC:sim-toolbar] Верхняя панель выбора сценария, импорта OSM и завершения попытки */}
      <div data-testid="sim-toolbar" hidden={menusHidden} className="sim-toolbar scroll-thin" style={menusHidden ? { display: "none" } : undefined}>
        <div className="segmented">
          {([
            ["bay_90", "1 · Бокс 90°"],
            ["parallel_v2", "2 · Параллельная"],
            ["city_osm", "3 · Город OSM"],
            ["custom", "4 · Свой сценарий"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={scenarioId === id ? "on" : ""}
              onClick={() => onScenarioChange(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".osm,.xml,.json,.geojson,application/json,application/xml,text/xml"
          className="hidden"
          onChange={handleOsmFile}
        />
        <button
          type="button"
          className="btn btn-mini"
          onClick={() => fileInputRef.current?.click()}
          title="Импорт локального .osm XML, Overpass OSM JSON или GeoJSON (до 30 МБ, офлайн)"
        >
          <Icon name="upload" size={13} /> OSM / GeoJSON
        </button>
        {customOsm && scenarioId === "city_osm" && (
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              onCustomOsmChange(null, null);
              setShowOsmCheck(false);
              onNotify("Восстановлен встроенный экзаменационный маршрут МРЭО");
            }}
          >
            Эталонный маршрут
          </button>
        )}

        <div className="sim-toolbar-actions">
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => resetAttempt(world, COLD_START)}
            title="Сбросить попытку (Backspace): ДВС заглушен, КПП P"
          >
            <Icon name="reset" size={13} /> Сброс
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              setHelpCollapsed(false);
              setShowHelp((v) => !v);
            }}
            title="Клавиши и управление"
          >
            <Icon name="help" size={13} /> Клавиши
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              setControlsCollapsed(false);
              setShowControls((v) => !v);
            }}
            title="Выворот колёс, скорость руления, педали и элементы HUD"
          >
            <Icon name="sliders" size={13} /> Управление
          </button>
          <button
            ref={fullscreenButtonRef}
            type="button"
            className="btn btn-mini"
            data-testid="sim-fullscreen-enter"
            onClick={enterImmersive}
            title="Полноэкранная сцена без меню и панелей · U — включить/выключить · Esc — выйти"
          >
            <Icon name="maximize" size={13} /> Полный экран
          </button>
          <button
            type="button"
            className="btn btn-primary btn-mini"
            onClick={handleFinishAndDebrief}
          >
            <Icon name="clipboard" size={13} /> Завершить → Разбор
          </button>
        </div>
      </div>

      {/* Панель проверки маршрута и произвольной границы для загруженного OSM-пакета (сворачиваемая и закрываемая) */}
      {!menusHidden && customOsm && scenarioId === "city_osm" && osmRouteCheck && osmBarClosed && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            className="btn btn-mini text-[#9bafbc]"
            onClick={() => {
              setOsmBarClosed(false);
              setOsmBarCollapsed(false);
            }}
            title="Вернуть панель проверки маршрута OSM"
          >
            + Панель маршрута OSM
          </button>
        </div>
      )}
      {!menusHidden && customOsm && scenarioId === "city_osm" && osmRouteCheck && !osmBarClosed && (
        <div
          data-testid="sim-osm-route-bar"
          className="panel px-3 py-2 text-[11px] space-y-2 border hairline"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="sim-osm-route-status"
              onClick={() => {
                setOsmBarCollapsed(false);
                setShowOsmCheck((v) => !v);
              }}
              className="inline-flex items-center gap-1.5"
              title="Показать подробный отчёт проверки маршрута OSM"
            >
              <Chip
                tone={
                  osmRouteCheck.status === "valid"
                    ? "mint"
                    : osmRouteCheck.status === "warnings" || osmRouteCheck.status === "empty"
                      ? "amber"
                      : "red"
                }
              >
                {osmRouteCheck.status === "valid"
                  ? `✓ Маршрут: ${osmRouteCheck.checkpointsCount} КТ · ${osmRouteCheck.totalLengthM} м`
                  : osmRouteCheck.status === "warnings" || osmRouteCheck.status === "empty"
                    ? `⚠ Проверка: замечаний ${osmRouteCheck.issues.length}`
                    : `✕ Проверка: ошибок ${osmRouteCheck.issues.filter((i) => i.severity === "error").length}`}
              </Chip>
            </button>

            <span className="mono text-[10px] text-[#9bafbc]">
              {Math.round(customOsm.bounds.maxX - customOsm.bounds.minX)}×
              {Math.round(customOsm.bounds.maxZ - customOsm.bounds.minZ)} м
              {customOsm.boundaryPolygon ? ` · контур ${customOsm.boundaryPolygon.length} т.` : ""}
              {(customOsm.meta.resolvedConflictsCount ?? 0) > 0
                ? ` · согласовано ${customOsm.meta.resolvedConflictsCount}`
                : ""}
            </span>

            {!osmBarCollapsed && osmCandidates.length > 0 && (
              <select
                aria-label="Улица маршрута OSM"
                value={osmRouteCandidate}
                onChange={(ev) => applyOsmRouteVariant(ev.target.value, osmRouteReverse)}
                className="bg-[#0b131a] border hairline rounded-lg px-2 py-1 text-[11px] max-w-[220px]"
              >
                <option value="">Автовыбор улицы ({customOsm.routeRoadName || "главная"})</option>
                {osmCandidates.slice(0, 12).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.oneway ? "→ " : ""}
                    {c.name} · {c.lengthM} м{c.oneway ? " (1-стор.)" : ""}
                  </option>
                ))}
              </select>
            )}

            {!osmBarCollapsed && (
              <>
                <button
                  type="button"
                  className="btn btn-mini"
                  disabled={Boolean(selectedOsmCandidate?.oneway)}
                  onClick={() => applyOsmRouteVariant(osmRouteCandidate, !osmRouteReverse)}
                  title={
                    selectedOsmCandidate?.oneway
                      ? "Односторонняя улица OSM — реверс против потока отключён"
                      : "Развернуть направление маршрута по выбранной улице"
                  }
                >
                  {selectedOsmCandidate?.oneway ? "→ 1-стор." : "⇄ Реверс"}
                </button>

                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={applyOsmCorridorCrop}
                  title="Обрезать загруженную карту по коридору вдоль маршрута (вместо прямоугольника)"
                >
                  ⬠ Коридор маршрута
                </button>

                {customOsm.boundaryPolygon && rawCustomOsm && (
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      onCustomOsmChange(rawCustomOsm, rawCustomOsm);
                      onNotify("Восстановлена полная выгрузка OSM до обрезки");
                    }}
                  >
                    Вся выгрузка
                  </button>
                )}

                {osmRouteCheck.canAutoFix && (
                  <button type="button" className="btn btn-mini text-[#f5b942]" onClick={fixOsmRouteInPlace}>
                    Исправить маршрут
                  </button>
                )}

                <button
                  type="button"
                  data-testid="sim-osm-open-editor"
                  className="btn btn-mini ml-auto text-[#52d6bd]"
                  onClick={() => onEditOsmInEditor(customOsm, rawCustomOsm ?? customOsm)}
                  title="Открыть загруженную карту в 2D-редакторе для рисования произвольных границ и расстановки знаков/КТ"
                >
                  <Icon name="sliders" size={12} /> Границы и маршрут → Редактор
                </button>
              </>
            )}

            <div className={`inline-flex items-center gap-1 ${osmBarCollapsed ? "ml-auto" : ""}`}>
              <button
                type="button"
                aria-label={osmBarCollapsed ? "Развернуть панель маршрута OSM" : "Свернуть панель маршрута OSM"}
                title={osmBarCollapsed ? "Развернуть панель маршрута OSM" : "Свернуть панель маршрута OSM"}
                onClick={() => setOsmBarCollapsed((v) => !v)}
                className="mono h-6 w-6 rounded-md border hairline grid place-items-center text-xs text-[#9bafbc] hover:text-[#f5b942]"
              >
                {osmBarCollapsed ? "+" : "−"}
              </button>
              <button
                type="button"
                aria-label="Закрыть панель маршрута OSM"
                title="Скрыть панель маршрута OSM"
                onClick={() => setOsmBarClosed(true)}
                className="mono h-6 w-6 rounded-md border hairline grid place-items-center text-xs text-[#9bafbc] hover:text-[#ff8080]"
              >
                ×
              </button>
            </div>
          </div>

          {!osmBarCollapsed && showOsmCheck && (
            <div className="pt-1.5 border-t hairline space-y-1 text-[11px]">
              <div className="text-[#c5d4df] font-semibold">{osmRouteCheck.summary}</div>
              {osmRouteCheck.issues.length === 0 ? (
                <div className="text-[#52d6bd]">
                  Все {osmRouteCheck.legs.length} сегментов связаны по дорожной сети, старт и КТ внутри границы и без коллизий.
                </div>
              ) : (
                <ul className="space-y-0.5 text-[#9bafbc]">
                  {osmRouteCheck.issues.map((iss, idx) => (
                    <li
                      key={idx}
                      className={
                        iss.severity === "error"
                          ? "text-[#ff8080]"
                          : iss.severity === "warning"
                            ? "text-[#f5b942]"
                            : "text-[#9bafbc]"
                      }
                    >
                      • {iss.message}
                    </li>
                  ))}
                </ul>
              )}
              {customOsm.meta.conflictNotes && customOsm.meta.conflictNotes.length > 0 && (
                <div className="pt-1 border-t border-white/10 text-[10px] text-[#9bafbc]" data-testid="sim-osm-deconflict-notes">
                  <span className="mono text-[#52d6bd] font-semibold">СОГЛАСОВАНИЕ С РЕАЛЬНОЙ КАРТОЙ:</span>{" "}
                  {customOsm.meta.conflictNotes.join(" · ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Главная 3D-сцена с зеркалами, статусом экзаменатора и органами управления */}
      <div
        ref={containerRef}
        data-testid="sim-viewport"
        data-immersive={immersive ? "true" : "false"}
        data-menus-hidden={menusHidden ? "true" : "false"}
        onContextMenu={(e) => e.preventDefault()}
        className="relative isolate w-full h-[560px] lg:h-[calc(100vh-152px)] min-h-[520px] max-h-[820px] rounded-2xl overflow-hidden border hairline bg-[#0d1720] select-none"
      >
        <div className="absolute bottom-2 left-2 z-[10001] flex gap-1" data-testid="sim-quick-menu">
          <button type="button" className="btn btn-mini" data-testid="sim-menus-toggle" onClick={onToggleMenus}
            aria-expanded={!menusHidden} aria-label={menusHidden ? "Показать верхние меню" : "Скрыть верхние меню"}
            title={menusHidden ? "Показать навигацию и панель сценариев" : "Скрыть навигацию и панель сценариев"}>☰</button>
          <button type="button" className="btn btn-mini" data-testid="sim-hud-toggle" aria-pressed={uiHidden}
            onClick={() => setUiHidden((v) => !v)}>{uiHidden ? "Показать интерфейс" : "Скрыть интерфейс"} · {keyLabel(bindings.KeyV)}</button>
          <button type="button" className="btn btn-mini" onClick={() => { setControlsCollapsed(false); setShowControls((v) => !v); }}>
            Настройки · {keyLabel(bindings.KeyO)}
          </button>
        </div>
        {immersive && (
          <button
            type="button"
            data-testid="sim-fullscreen-exit"
            onClick={leaveImmersive}
            className="absolute right-3 top-3 z-[10000] rounded-lg border border-white/20 bg-[#0b131b]/90 px-3 py-2 text-xs text-white shadow-lg hover:border-[#f5b942]"
            title="Выйти из полноэкранного режима (Esc)"
          >
            ✕ Выйти · Esc <span className="text-[#9bafbc]">/ {keyLabel(bindings.KeyU)}</span>
          </button>
        )}
        <canvas
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerEnd}
          onPointerCancel={handleCanvasPointerEnd}
          onPointerLeave={handleCanvasPointerLeave}
          onWheel={(e) => {
            e.preventDefault();
            const ctrl = sceneCtrlRef.current;
            if (ctrl && cameraMode === "cockpit" && shifterHoverRef.current !== null && Math.abs(e.deltaY) > 0) {
              // Вращение колеса над 3D-рычагом АКПП: вниз — P→R→N→D (в M: −1), вверх — D→N→R→P (в M: +1)
              const inMan = isManualGear(inputRef.current.gear);
              const dir: 1 | -1 = inMan ? (e.deltaY < 0 ? 1 : -1) : e.deltaY > 0 ? 1 : -1;
              stepCockpitShifter(dir);
              return;
            }
            ctrl?.adjustZoom(e.deltaY);
          }}
          className={`block w-full h-full touch-none ${
            cockpitShifterUi
              ? cockpitShifterUi.dragging
                ? "cursor-grabbing"
                : cockpitShifterUi.hit === "lever"
                  ? "cursor-grab"
                  : "cursor-pointer"
              : "cursor-grab active:cursor-grabbing"
          }`}
        />

        {/* [SEC:sim-mirrors] Зеркала (320×96 и 320×160; в «Салоне» отражения рендерятся на физических 3D-зеркалах) и руль */}
        {!webglFallback && cameraMode !== "cockpit" && showRearMirror && !isPanelClosed("mirrorRear") && (
          <FloatingPanel
            id="mirrorRear"
            title="Зеркало заднего вида"
            label="Зеркало заднего вида"
            collapsedSummary="Зеркало задн."
            collapsed={isPanelCollapsed("mirrorRear")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            icon="eye"
            layout={layout.mirrorRear}
            defaults={(cw) => ({ x: Math.max(0, (cw - 270) / 2), y: 6, w: 270 })}
            minW={140}
            maxW={640}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("mirrorRear")}
            containerRef={containerRef}
            zIndex={panelZ("mirrorRear", 26)}
          >
            <canvas ref={rearMirrorRef} role="img" aria-label="Отражение в зеркале заднего вида" width={320} height={96} className="block w-full h-auto" />
          </FloatingPanel>
        )}
        {!webglFallback && cameraMode !== "cockpit" && showMirrors && !isPanelClosed("mirrorLeft") && (
          <FloatingPanel
            id="mirrorLeft"
            label="Левое зеркало"
            collapsedSummary="Левое зеркало"
            collapsed={isPanelCollapsed("mirrorLeft")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.mirrorLeft}
            defaults={(_cw, ch) => ({ x: 12, y: Math.max(120, ch - 470), w: 170 })}
            minW={100}
            maxW={420}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("mirrorLeft")}
            containerRef={containerRef}
            zIndex={panelZ("mirrorLeft", 25)}
          >
            <canvas ref={leftMirrorRef} role="img" aria-label="Отражение в левом зеркале" width={320} height={160} className="block w-full h-auto" />
          </FloatingPanel>
        )}
        {!webglFallback && cameraMode !== "cockpit" && showMirrors && !isPanelClosed("mirrorRight") && (
          <FloatingPanel
            id="mirrorRight"
            label="Правое зеркало"
            collapsedSummary="Правое зеркало"
            collapsed={isPanelCollapsed("mirrorRight")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.mirrorRight}
            defaults={(cw, ch) => ({ x: Math.max(0, cw - 182), y: Math.max(120, ch - 470), w: 170 })}
            minW={100}
            maxW={420}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("mirrorRight")}
            containerRef={containerRef}
            zIndex={panelZ("mirrorRight", 25)}
          >
            <canvas ref={rightMirrorRef} role="img" aria-label="Отражение в правом зеркале" width={320} height={160} className="block w-full h-auto" />
          </FloatingPanel>
        )}

        {/* Рулевое колесо: перетаскивается, масштабируется, сворачивается и закрывается */}
        {!uiHidden && !webglFallback && !isPanelClosed("steeringWheel") && (
          <FloatingPanel
            id="steeringWheel"
            label="Руль"
            collapsedSummary={`Руль · ${s.swDeg > 1 ? `←${Math.round(s.swDeg)}°` : s.swDeg < -1 ? `${Math.round(-s.swDeg)}°→` : "0°"}`}
            collapsed={isPanelCollapsed("steeringWheel")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.steeringWheel}
            defaults={(cw, ch) => cw < 720
              ? {x: 8, y: ch - 162, w: 106}
              : {x: 12, y: Math.max(194, ch - 352), w: 150}}
            minW={96}
            maxW={320}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("steeringWheel")}
            containerRef={containerRef}
            zIndex={panelZ("steeringWheel", 24)}
          >
            <div className="p-2 flex flex-col gap-1.5">
              <svg
                ref={wheelSvgRef}
                viewBox="0 0 100 100"
                style={{ display: "block", width: "100%", height: "auto" }}
                onPointerDown={handleWheelDown}
                onPointerMove={handleWheelMove}
                onPointerUp={handleWheelEnd}
                onPointerCancel={handleWheelEnd}
                onDoubleClick={() => {
                  inputRef.current.steerWheelDeg = 0;
                }}
                className="cursor-grab active:cursor-grabbing touch-none"
                aria-label="Рулевое колесо"
              >
                <g ref={wheelGroupRef}>
                  <circle cx="50" cy="50" r="41" fill="none" stroke="#dbe7ef" strokeWidth="8.5" />
                  <path d="M50 50 L14 46 M50 50 L86 46 M50 50 L50 88" stroke="#9fb3c2" strokeWidth="7" strokeLinecap="round" />
                  <circle cx="50" cy="50" r="11" fill="#182430" stroke="#9fb3c2" strokeWidth="2" />
                  <rect x="46" y="4" width="8" height="11" rx="2" fill="#f5b942" />
                </g>
              </svg>
              <div className="flex items-center justify-between mono text-[9px] leading-tight">
                <span className="text-[#e9f1f5] font-bold">
                  {s.swDeg > 1 ? `← ${Math.round(s.swDeg)}°` : s.swDeg < -1 ? `${Math.round(-s.swDeg)}° →` : "0°"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    inputRef.current.steerWheelDeg = 0;
                  }}
                  className="text-[#f5b942] hover:underline"
                >
                  Выровнять
                </button>
              </div>
              <div className="wheel-readout mono" title="Текущие углы левого и правого передних колёс">
                Л {((s.steerLeft * 180) / Math.PI).toFixed(1)}° · П {((s.steerRight * 180) / Math.PI).toFixed(1)}°
              </div>
              <button type="button" className="wheel-limit-shortcut" title="Настроить угол поворота колёс"
                onClick={() => { setShowControls(true); setShowHelp(false); }}>
                <Icon name="sliders" size={11} /><span>Выворот</span><b className="mono">{wheelLimit.toLocaleString("ru-RU")}°</b>
              </button>
            </div>
          </FloatingPanel>
        )}

        {/* [SEC:sim-hud] Штрафы, знаки/светофор/FPS, статус экзаменатора, настройки, справка и камера */}
        {!uiHidden && !isPanelClosed("scorePanel") && (
          <FloatingPanel
            id="scorePanel"
            label="Оценка"
            collapsedSummary={`${hud.evalRes.verdict} · ${hud.evalRes.totalPoints}/${hud.evalRes.failThreshold} б.`}
            collapsed={isPanelCollapsed("scorePanel")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.scorePanel}
            defaults={() => ({ x: 12, y: 12, w: 232 })}
            minW={190}
            maxW={460}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("scorePanel")}
            containerRef={containerRef}
            zIndex={panelZ("scorePanel", 20)}
          >
            <div className="px-3 py-2 pr-7">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  hud.evalRes.verdict === "СДАЛ" ? "bg-[#52d6bd]" : "bg-[#ff6b6b]"
                }`}
              />
              <span
                className={`mono text-xs font-bold ${
                  hud.evalRes.verdict === "СДАЛ" ? "text-[#52d6bd]" : "text-[#ff6b6b]"
                }`}
              >
                {hud.evalRes.verdict}
              </span>
              <span className="mono text-xs text-[#e9f1f5] ml-auto">
                {hud.evalRes.totalPoints}/{hud.evalRes.failThreshold} б.
              </span>
            </div>
            <div className="mono text-[10px] text-[#8fa2ae] mt-1 flex items-center justify-between gap-2">
              <span>v8: {hud.evalRes.legacyV8Score}/100</span>
              <span>касаний: {s.collisions}</span>
            </div>
            </div>
          </FloatingPanel>
        )}

        {/* Правый верхний блок: знак скорости + светофор + FPS */}
        {!uiHidden && !isPanelClosed("speedPanel") && (
          <FloatingPanel
            id="speedPanel"
            label="Лимит и FPS"
            collapsedSummary={`${hud.speedLimit} км/ч · ${hud.perf.fps} FPS`}
            collapsed={isPanelCollapsed("speedPanel")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.speedPanel}
            defaults={(cw) => ({ x: Math.max(0, cw - 236), y: 12, w: 232 })}
            minW={150}
            maxW={480}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("speedPanel")}
            containerRef={containerRef}
            zIndex={panelZ("speedPanel", 20)}
          >
            <div className="flex items-center gap-2 px-8 py-1.5 flex-wrap">
            {hud.nextSignal && (
              <div className="rounded-xl bg-[#091017]/86 backdrop-blur-md border hairline px-2.5 py-1.5 flex items-center gap-2">
                <span
                  className={`h-3 w-3 rounded-full ${
                    hud.nextSignal.phase === "red" || hud.nextSignal.phase === "red_yellow"
                      ? "bg-[#ff4d4d] shadow-[0_0_8px_#ff4d4d]"
                      : hud.nextSignal.phase === "yellow"
                        ? "bg-[#f5b942] shadow-[0_0_8px_#f5b942]"
                        : "bg-[#22e584] shadow-[0_0_8px_#22e584]"
                  }`}
                />
                <span className="mono text-xs font-bold">{hud.nextSignal.sec}с</span>
              </div>
            )}
            <div
              className={`h-10 w-10 rounded-full bg-white border-[4px] grid place-items-center font-extrabold text-[13px] text-slate-900 shadow-lg ${
                kmh > hud.speedLimit + 1 ? "border-[#ff2e2e] ring-2 ring-[#ff6b6b]" : "border-[#dc2626]"
              }`}
              title={`Ограничение скорости: ${hud.speedLimit} км/ч`}
            >
              {hud.speedLimit}
            </div>
            <div className="hidden sm:block rounded-xl bg-[#091017]/84 backdrop-blur-md border hairline px-2.5 py-1.5 mono text-[10px] text-[#9bafbc] leading-tight">
              <div>
                <b className={hud.perf.fps >= 30 ? "text-[#52d6bd]" : "text-[#ff6b6b]"}>{hud.perf.fps}</b> FPS · p95{" "}
                {hud.perf.p95FrameMs}мс
              </div>
              <div className="text-[#6e8492]">
                Grid {hud.gridChecks}/{hud.totalObstacles}
              </div>
            </div>
            </div>
          </FloatingPanel>
        )}

        {/* Строка статуса / задания экзаменатора (#status) */}
        {!uiHidden && !isPanelClosed("statusBar") && (
          <FloatingPanel
            id="statusBar"
            label="Задание"
            collapsedSummary="Задание экзаменатора"
            collapsed={isPanelCollapsed("statusBar")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.statusBar}
            defaults={(cw) => ({ x: Math.max(0, (cw - 540) / 2), y: 148, w: 540 })}
            minW={300}
            maxW={820}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("statusBar")}
            containerRef={containerRef}
            zIndex={panelZ("statusBar", 20)}
          >
            <div className="px-8 py-1.5">
            <div
              className={`rounded-xl px-3.5 py-2 backdrop-blur-md border text-[12px] font-semibold text-center shadow-lg flex flex-wrap items-center justify-center gap-2 ${
                s.finished && s.finishedReason === "completed"
                  ? "bg-[#0a2621]/92 border-[#52d6bd]/60 text-[#d1fae5]"
                  : s.inContact || s.inLineCross
                    ? "bg-[#2c1115]/92 border-[#ff6b6b]/60 text-[#fecaca]"
                    : "bg-[#091017]/85 border-[rgba(148,176,194,.22)] text-[#e9f1f5]"
              }`}
            >
              <span>{s.statusText}</span>
              {needsPrep && !s.finished && (
                <button type="button" onClick={handleQuickStart} className="btn btn-primary btn-mini py-1 px-2.5">
                  Быстрый старт
                </button>
              )}
              {s.finished && (
                <button type="button" onClick={handleFinishAndDebrief} className="btn btn-primary btn-mini py-1 px-2.5">
                  Открыть протокол →
                </button>
              )}
            </div>
            </div>
          </FloatingPanel>
        )}

        {/* Всплывающая карточка зафиксированного нарушения (с кнопкой закрытия ×) */}
        {!uiHidden && hud.latestViolation && (
          <div className="absolute left-1/2 -translate-x-1/2 top-[210px] z-50 rounded-xl bg-[#2a0f14]/95 border border-[#ff6b6b]/60 px-3.5 py-2 shadow-2xl max-w-[90%] fade-in">
            <div className="flex items-center gap-2 text-[11px] font-extrabold text-[#ff8585]">
              <Icon name="alert" size={14} />
              <span>+{hud.latestViolation.points} б. · {hud.latestViolation.title}</span>
              <button
                type="button"
                aria-label="Закрыть уведомление о нарушении"
                title="Закрыть уведомление"
                onClick={() => {
                  latestViolationRef.current = null;
                  setHud((prev) => ({ ...prev, latestViolation: null }));
                }}
                className="ml-auto mono text-xs text-[#f3d4d7]/75 hover:text-white px-1 cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="text-[11px] text-[#f3d4d7] mt-0.5">{hud.latestViolation.detail}</div>
          </div>
        )}

        {/* Компактный док восстановления закрытых/свёрнутых элементов HUD */}
        {!uiHidden && (panelState.closed.length > 0 || panelState.collapsed.length > 0 || showPanelsMenu) && (
          <div className="absolute right-3 top-16 z-40 flex flex-col items-end gap-1.5">
            <button
              type="button"
              data-testid="hud-restore-dock"
              onClick={() => setShowPanelsMenu((v) => !v)}
              className="mono px-2.5 py-1 rounded-lg text-[10px] font-bold border bg-[#0b131b]/94 border-[#f5b942]/55 text-[#f5b942] shadow-lg hover:bg-[#13202c] cursor-pointer"
              title="Показать, свернуть или закрыть элементы интерфейса"
            >
              Окна
              {panelState.closed.length > 0 ? ` · закрыто ${panelState.closed.length}` : ""}
              {panelState.collapsed.length > 0 ? ` · свёрн. ${panelState.collapsed.length}` : ""}
            </button>
            {showPanelsMenu && (
              <div
                data-testid="hud-panels-menu"
                className="w-[244px] rounded-xl bg-[#0b131b]/97 backdrop-blur-md border hairline p-3 shadow-2xl space-y-2 fade-in"
              >
                <div className="flex items-center justify-between">
                  <span className="mono text-[10px] font-bold text-[#f5b942]">ЭЛЕМЕНТЫ ИНТЕРФЕЙСА</span>
                  <button
                    type="button"
                    aria-label="Закрыть меню окон"
                    onClick={() => setShowPanelsMenu(false)}
                    className="mono text-xs text-[#8fa2ae] hover:text-white cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                <div className="space-y-1 max-h-[250px] overflow-y-auto scroll-thin pr-0.5">
                  {HUD_PANEL_CATALOG.map((item) => {
                    const closed = isPanelClosed(item.id);
                    const collapsed = isPanelCollapsed(item.id);
                    return (
                      <div key={item.id} className="flex items-center justify-between gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={() => (closed || collapsed ? handleRestorePanel(item.id) : handleClosePanel(item.id))}
                          className={`truncate text-left flex-1 py-0.5 cursor-pointer ${
                            closed ? "text-[#6e8492] line-through" : collapsed ? "text-[#f5b942]" : "text-[#d9e6ee]"
                          }`}
                          title={closed ? "Показать элемент" : "Скрыть элемент"}
                        >
                          {item.label}
                        </button>
                        <div className="flex items-center gap-0.5 shrink-0">
                          {!closed && (
                            <button
                              type="button"
                              onClick={() => handleToggleCollapse(item.id)}
                              title={collapsed ? "Развернуть" : "Свернуть"}
                              className="mono h-5 w-5 rounded border hairline text-[10px] text-[#9bafbc] hover:text-[#f5b942] cursor-pointer"
                            >
                              {collapsed ? "+" : "−"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => (closed ? handleRestorePanel(item.id) : handleClosePanel(item.id))}
                            title={closed ? "Открыть заново" : "Закрыть"}
                            className={`mono h-5 px-1.5 rounded border hairline text-[10px] cursor-pointer ${
                              closed ? "text-[#52d6bd] border-[#52d6bd]/40" : "text-[#9bafbc] hover:text-[#ff8080]"
                            }`}
                          >
                            {closed ? "Показать" : "×"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="pt-1.5 border-t hairline flex items-center gap-1.5">
                  <button type="button" className="btn btn-mini flex-1 text-[#52d6bd]" onClick={handleRestoreAllPanels}>
                    Показать все
                  </button>
                  <button type="button" className="btn btn-mini flex-1" onClick={handleCollapseAllHud}>
                    Свернуть HUD
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Настройки управления: выворот, скорость руления, элементы HUD и сброс раскладки */}
        {showControls && (
          <div className="absolute right-3 top-16 z-[10002] w-[310px] max-h-[calc(100%-5rem)] overflow-y-auto scroll-thin rounded-2xl bg-[#0b131b]/96 backdrop-blur-md border hairline p-4 shadow-2xl fade-in">
            <div className={`flex items-center justify-between ${controlsCollapsed ? "" : "mb-3"}`}>
              <span className="text-xs font-extrabold text-[#f5b942]">Управление</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={controlsCollapsed ? "Развернуть настройки управления" : "Свернуть настройки управления"}
                  title={controlsCollapsed ? "Развернуть" : "Свернуть"}
                  className="mono h-5 w-5 rounded grid place-items-center text-xs text-[#8fa2ae] hover:text-[#f5b942] hover:bg-white/10"
                  onClick={() => setControlsCollapsed((v) => !v)}
                >
                  {controlsCollapsed ? "+" : "−"}
                </button>
                <button type="button" aria-label="Закрыть настройки управления" className="mono text-xs text-[#8fa2ae] hover:text-white" onClick={() => setShowControls(false)}>
                  ✕
                </button>
              </div>
            </div>
            {!controlsCollapsed && (
              <>
            <KeyBindingsEditor value={bindings} onChange={setBindings} />
            <div className="mb-4"><SteeringLimitControl value={wheelLimit} onChange={onWheelLockChange} /></div>
            <label className="block text-[11px] text-[#d3e0e7] mb-1.5" htmlFor="key-steer-rate">
              Скорость руления клавишами A / D:{" "}
              <b className="mono text-[#f5b942]">{steerKeyRate}°/с</b>
            </label>
            <input
              type="range"
              id="key-steer-rate"
              min={60}
              max={900}
              step={10}
              value={steerKeyRate}
              onChange={(e) => setSteerKeyRate(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex gap-1.5 mt-2.5">
              {([
                ["Плавно", 120],
                ["Обычно", 340],
                ["Быстро", 700],
              ] as const).map(([label, value]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSteerKeyRate(value)}
                  className={`btn btn-mini flex-1 ${steerKeyRate === value ? "border-[#f5b942]/60 text-[#f5b942]" : ""}`}
                >
                  {label} · {value}
                </button>
              ))}
            </div>
            <div className="mono text-[10px] text-[#7c909d] mt-2.5 leading-relaxed">
              Полный поворот от упора до упора (±540°) займёт {(1080 / steerKeyRate).toFixed(1)} с. Мышь и экранный руль работают независимо от этой настройки.
            </div>

            {/* USB-руль и педали: отдельная панель с калибровкой по шагам */}
            <GamepadPanel profile={padProfile} onChange={setPadProfile} onNotify={onNotify} />

            <div className="mt-3 pt-3 border-t hairline" data-testid="controls-headunit">
              <div className="mono text-[10px] text-[#7c909d] mb-1.5">7" ШГУ · МУЛЬТИМЕДИА</div>
              <div className="flex flex-wrap gap-1.5">
                {HEAD_UNIT_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    data-headunit-mode={m.id}
                    aria-pressed={headUnit.mode === m.id}
                    onClick={() => setHeadUnitMode(m.id)}
                    className={`btn btn-mini ${headUnit.mode === m.id ? "border-[#52d6bd]/60 text-[#52d6bd] bg-[#52d6bd]/10" : ""}`}
                  >
                    {m.short}
                  </button>
                ))}
              </div>

              {/* Реальная интернет-станция: прямое подключение к живому эфиру */}
              <div className="mt-2 rounded-lg bg-[#0c1520] border hairline px-2 py-1.5">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="mono text-[10px] text-[#52d6bd]">
                    FM {radioStations[clamp(headUnit.stationIndex, 0, radioStations.length - 1)].freq}
                  </span>
                  <span className="truncate text-[10px] text-[#d3e0e7]">
                    {radioStations[clamp(headUnit.stationIndex, 0, radioStations.length - 1)].name}
                  </span>
                </div>
                <div className="mono text-[9.5px] text-[#7c909d] mt-0.5">
                  {radioStations[clamp(headUnit.stationIndex, 0, radioStations.length - 1)].genre} ·{" "}
                  {headUnit.source === "saved"
                    ? "КЭШИРОВАННЫЙ ТРЕК"
                    : headUnit.streamStatus === "live"
                      ? "ЖИВОЙ ЭФИР"
                      : headUnit.streamStatus === "connecting"
                        ? "ПОДКЛЮЧЕНИЕ…"
                        : headUnit.streamStatus === "error"
                          ? "ЭФИР НЕДОСТУПЕН"
                          : "ИНТЕРНЕТ-РАДИО"}
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button type="button" className="btn btn-mini" onClick={() => stepRadioStation(-1)} aria-label="Предыдущая станция">
                  ◀
                </button>
                <button type="button" className="btn btn-mini" onClick={() => stepRadioStation(1)} aria-label="Следующая станция">
                  ▶
                </button>
                <button
                  type="button"
                  data-testid="headunit-play"
                  className={`btn btn-mini ${headUnit.radioPlaying ? "border-[#52d6bd]/60 text-[#52d6bd]" : ""}`}
                  onClick={toggleRadioPlay}
                  aria-pressed={headUnit.radioPlaying}
                >
                  {headUnit.radioPlaying ? "Пауза" : "Эфир"}
                </button>
                <button type="button" className="btn btn-mini" onClick={() => changeVolume(-VOLUME_STEP)} aria-label="Тише">
                  VOL −
                </button>
                <button type="button" className="btn btn-mini" onClick={() => changeVolume(VOLUME_STEP)} aria-label="Громче">
                  VOL +
                </button>
                <button type="button" className="btn btn-mini" onClick={stepHeadUnitClip}>
                  Клип ↻
                </button>
              </div>
              <div className="mono text-[9.5px] text-[#7c909d] mt-1">
                Громкость: {Math.round(headUnit.volume * 100)}% · {HEAD_UNIT_CLIPS[headUnit.clipIndex].title}
              </div>

              {/* Сохранение трека во время поездки: офлайн-рендер эфира в WAV → кэш IndexedDB `cdt-audio` */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="sound-toggle"
                  aria-pressed={soundEnabled}
                  onClick={() => {
                    setSoundEnabled((v) => {
                      onNotify(v ? "Звук тренажёра выключен" : "Звук тренажёра включён: ДВС, шины и ШГУ");
                      return !v;
                    });
                  }}
                  className={`btn btn-mini ${soundEnabled ? "border-[#52d6bd]/60 text-[#52d6bd] bg-[#52d6bd]/10" : ""}`}
                >
                  {soundEnabled ? "Звук ВКЛ" : "Звук ВЫКЛ"}
                </button>
                <button
                  type="button"
                  data-testid="sound-engine-toggle"
                  aria-pressed={soundLayers.engine}
                  onClick={() => toggleSoundLayer("engine")}
                  className={`btn btn-mini ${soundLayers.engine ? "border-[#52d6bd]/60 text-[#52d6bd] bg-[#52d6bd]/10" : ""}`}
                  title="ДВС и шум шин"
                >
                  ДВС {soundLayers.engine ? "ВКЛ" : "ВЫКЛ"}
                </button>
                <button
                  type="button"
                  data-testid="sound-horn-toggle"
                  aria-pressed={soundLayers.horn}
                  onClick={() => toggleSoundLayer("horn")}
                  className={`btn btn-mini ${soundLayers.horn ? "border-[#52d6bd]/60 text-[#52d6bd] bg-[#52d6bd]/10" : ""}`}
                  title="Сигнал (клаксон) на руле — клавиша H"
                >
                  Сигнал {soundLayers.horn ? "ВКЛ" : "ВЫКЛ"}
                </button>
                <button
                  type="button"
                  data-testid="sound-indicator-toggle"
                  aria-pressed={soundLayers.indicator}
                  onClick={() => toggleSoundLayer("indicator")}
                  className={`btn btn-mini ${soundLayers.indicator ? "border-[#52d6bd]/60 text-[#52d6bd] bg-[#52d6bd]/10" : ""}`}
                  title="Щелчок реле поворотника и аварийки"
                >
                  Реле {soundLayers.indicator ? "ВКЛ" : "ВЫКЛ"}
                </button>
                <button
                  type="button"
                  data-testid="headunit-save-track"
                  className="btn btn-mini border-[#f5b942]/60 text-[#f5b942]"
                  onClick={() => void saveCurrentTrack()}
                  title="Сохранить 32-секундный трек текущей станции в кэш браузера — играет без интернета"
                >
                  ⤓ Сохранить трек в поездке
                </button>
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() =>
                    headUnit.source === "saved"
                      ? setHeadUnit((prev) => ({ ...prev, source: "stream", savedTrackKey: null, radioPlaying: true }))
                      : savedTracks[0] &&
                        setHeadUnit((prev) => ({
                          ...prev,
                          mode: "radio",
                          source: "saved",
                          savedTrackKey: savedTracks[0].key,
                          radioPlaying: true,
                        }))
                  }
                  disabled={savedTracks.length === 0}
                >
                  {headUnit.source === "saved" ? "Вернуть эфир" : "Слушать кэш"}
                </button>
              </div>
              {audioError && (
                <div className="text-[10px] text-[#f5b942] mt-1" data-testid="headunit-audio-error">
                  {audioError}
                </div>
              )}

              <div className="mt-2 mono text-[9.5px] text-[#7c909d]">
                КЭШ ТРЕКОВ · {savedTracks.length} · {trackStore.trackBackend() === "indexeddb" ? "IndexedDB" : "память"}
              </div>
              <div className="mt-1 max-h-[104px] overflow-y-auto scroll-thin space-y-1" data-testid="headunit-tracklist">
                {savedTracks.length === 0 && (
                  <div className="text-[10px] text-[#6e8492]">
                    Пока пусто: нажмите «Сохранить трек в поездке».
                  </div>
                )}
                {savedTracks.map((t) => (
                  <div key={t.key} className="flex items-center gap-1.5 rounded border hairline px-1.5 py-1">
                    <button
                      type="button"
                      className={`flex-1 text-left text-[10px] ${headUnit.savedTrackKey === t.key ? "text-[#52d6bd]" : "text-[#c5d4de]"}`}
                      onClick={() =>
                        setHeadUnit((prev) => ({
                          ...prev,
                          mode: "radio",
                          source: "saved",
                          savedTrackKey: t.key,
                          radioPlaying: true,
                        }))
                      }
                    >
                      FM {t.freq} · {t.stationName} · {Math.round(t.seconds)} с
                    </button>
                    <button
                      type="button"
                      className="mono text-[10px] text-[#8fa2ae] hover:text-[#ff8585]"
                      aria-label={`Удалить трек ${t.stationName}`}
                      onClick={() => void removeSavedTrack(t.key)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 pt-3 border-t hairline">
              <div className="mono text-[10px] text-[#7c909d] mb-1.5">ЗЕРКАЛА (НЕЗАВИСИМО)</div>
              <div className="flex flex-wrap gap-1.5">
                {([
                  ["Боковые (2:1)", showMirrors && !(isPanelClosed("mirrorLeft") && isPanelClosed("mirrorRight")), toggleSideMirrors],
                  ["Заднее (3.33:1)", showRearMirror && !isPanelClosed("mirrorRear"), toggleRearMirror],
                ] as const).map(([label, on, toggle]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={toggle}
                    className={`btn btn-mini ${on ? "border-[#52d6bd]/60 text-[#52d6bd] bg-[#52d6bd]/10" : ""}`}
                    aria-pressed={on}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-[#52d6bd]" : "bg-[#6e8492]"}`} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 pt-3 border-t hairline">
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <span className="mono text-[10px] text-[#7c909d]">ОКНА ИНТЕРФЕЙСА (− / ×)</span>
                <div className="flex items-center gap-1">
                  <button type="button" className="mono text-[10px] text-[#f5b942] hover:underline" onClick={handleCollapseAllHud}>
                    Свернуть
                  </button>
                  <span className="text-[#4b5e6b]">·</span>
                  <button type="button" className="mono text-[10px] text-[#52d6bd] hover:underline" onClick={handleRestoreAllPanels}>
                    Все
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {HUD_PANEL_CATALOG.filter((p) => p.group === "hud").map((item) => {
                  const closed = isPanelClosed(item.id);
                  const collapsed = isPanelCollapsed(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => (closed || collapsed ? handleRestorePanel(item.id) : handleClosePanel(item.id))}
                      className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border transition cursor-pointer ${
                        closed
                          ? "border-[rgba(148,176,194,.16)] text-[#6e8492]"
                          : collapsed
                            ? "border-[#f5b942]/50 text-[#f5b942] bg-[#f5b942]/10"
                            : "border-[#52d6bd]/45 text-[#52d6bd] bg-[#52d6bd]/10"
                      }`}
                      title={closed ? "Показать элемент" : collapsed ? "Развернуть элемент" : "Закрыть элемент (можно также − / × на самой панели)"}
                    >
                      {item.label}{collapsed ? " (−)" : closed ? " (×)" : ""}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3 pt-3 border-t hairline flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#9bafbc]">Раскладка HUD</span>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => {
                  setLayout({});
                  setLayerOrder([]);
                  setPanelState({ collapsed: [], closed: [] });
                  setShowMirrors(true);
                  setShowRearMirror(true);
                  setShowPanelsMenu(false);
                  onNotify("Раскладка и видимость всех окон сброшены");
                }}
              >
                <Icon name="reset" size={12} /> Сбросить раскладку
              </button>
            </div>
            <p className="mt-2 text-[10px] text-[#93a6b0]">На каждой панели: «−» свернуть, «×» закрыть, удержание 0,4 с — перенести и вывести наверх. Клавиша H скрывает весь HUD.</p>
              </>
            )}
          </div>
        )}

        {/* Справка по клавишам (сворачиваемая и закрываемая) */}
        {showHelp && (
          <div className="absolute right-3 top-16 z-50 w-[300px] rounded-2xl bg-[#0b131b]/96 backdrop-blur-md border hairline p-4 shadow-2xl fade-in">
            <div className={`flex items-center justify-between ${helpCollapsed ? "" : "mb-2.5"}`}>
              <span className="text-xs font-extrabold text-[#f5b942]">Управление (клавиши)</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={helpCollapsed ? "Развернуть справку по клавишам" : "Свернуть справку по клавишам"}
                  title={helpCollapsed ? "Развернуть" : "Свернуть"}
                  className="mono h-5 w-5 rounded grid place-items-center text-xs text-[#8fa2ae] hover:text-[#f5b942] hover:bg-white/10"
                  onClick={() => setHelpCollapsed((v) => !v)}
                >
                  {helpCollapsed ? "+" : "−"}
                </button>
                <button
                  type="button"
                  aria-label="Закрыть справку по клавишам"
                  className="mono text-xs text-[#8fa2ae] hover:text-white"
                  onClick={() => setShowHelp(false)}
                >
                  ✕
                </button>
              </div>
            </div>
            {!helpCollapsed && (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
                {[
                  [keyLabel(bindings.KeyW), "Плавный газ · с модификатором — кикдаун"],
                  [keyLabel(bindings.KeyS), "Тормоз (в D не даёт реверс)"],
                  [`${keyLabel(bindings.KeyA)} / ${keyLabel(bindings.KeyD)}`, "Руль влево (+X) / вправо (−X)"],
                  ["ЛКМ / SVG", "Плавное вращение руля ±540°"],
                  ["← / →", "Взгляд: левое зеркало → дорога → правое зеркало"],
                  ["ПКМ + колесо", "Свободный обзор головой (не возвращается) · зум камеры"],
                  [`${keyLabel(bindings.ArrowUp)} / ${keyLabel(bindings.ArrowDown)}`, "Селектор P ↔ R ↔ N ↔ D"],
                  [`${keyLabel(bindings.ShiftLeft)} + ${keyLabel(bindings.ArrowUp)} / ${keyLabel(bindings.ArrowDown)}`, "Ручной режим M1–M6 (выше / ниже)"],
                  ["P / R / N / F", "Паркинг / Задний / Нейтраль / Авто D"],
                  ["G · 3D-рычаг", "Взгляд на АКПП и переключение мышью"],
                  ["I (в P/N)", "Запуск ДВС только из P или N"],
                  ["Q / E / Z", "Поворотники лев. / прав. / аварийка"],
                  ["I / Space / B", "Двигатель / Ручник / Ремень"],
                  [`${keyLabel(bindings.KeyL)} · ${keyLabel(bindings.KeyH)}`, "Фары · Сигнал"],
                  [keyLabel(bindings.KeyU), "Полный экран — включить / выключить (Esc — выйти)"],
                  [keyLabel(bindings.KeyV), "Скрыть / показать интерфейс"],
                  [keyLabel(bindings.KeyO), "Настройки и назначение клавиш"],
                  ["− / ×", "Свернуть / закрыть любую панель"],
                  ["1–4 / C", "Вид: сзади, салон, сверху, орбита"],
                ].map(([k, d]) => (
                  <div key={k} className="contents">
                    <span className="mono text-[#f5b942] font-semibold">{k}</span>
                    <span className="text-[#b9c9d3]">{d}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Переключатели камеры, траектории, зеркал и качества */}
        {!uiHidden && !isPanelClosed("camToggles") && (
          <FloatingPanel
            id="camToggles"
            label="Камера и вид"
            collapsedSummary={`Камера · ${cameraMode === "chase" ? "Сзади" : cameraMode === "cockpit" ? "Салон" : cameraMode === "top" ? "Сверху" : "Орбита"}`}
            collapsed={isPanelCollapsed("camToggles")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.camToggles}
            defaults={(cw, ch) => {
              const w = Math.min(660, cw - 16);
              return { x: (cw - w) / 2, y: ch - (cw < 720 ? 266 : cw < 960 ? 216 : 133), w };
            }}
            minW={250}
            maxW={680}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("camToggles")}
            containerRef={containerRef}
            zIndex={panelZ("camToggles", 21)}
            resizable={false}
          >
            <div className="flex flex-wrap items-center justify-center gap-1.5 pl-2 pr-6 py-1.5">
            {([
              ["chase", "1 Сзади"],
              ["cockpit", "2 Салон"],
              ["top", "3 Сверху"],
              ["orbit", "4 Орбита"],
            ] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setCameraMode(m)}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                  cameraMode === m
                    ? "bg-[#f5b942]/20 border-[#f5b942]/60 text-[#f5b942]"
                    : "bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#9bafbc] hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
            {cameraMode === "cockpit" && (
              <>
              {/* Три точки внимания: ← левое зеркало · дорога + салонное зеркало · правое зеркало → */}
              <div
                data-testid="head-detents"
                className="flex items-center gap-0.5 rounded-lg border border-[rgba(148,176,194,.18)] bg-[#091017]/80 p-0.5"
                title="Точки внимания водителя: ←/→ переключают левое зеркало → дорогу → правое зеркало"
              >
                <button
                  type="button"
                  data-testid="head-detent-left"
                  aria-pressed={headDetentUi === "left"}
                  onClick={() => {
                    sceneCtrlRef.current?.setHeadDetent(1);
                    setHeadDetentUi("left");
                    onNotify("Взгляд: левое зеркало");
                  }}
                  className={`px-1.5 py-1 rounded text-[10px] font-bold border transition ${
                    headDetentUi === "left"
                      ? "bg-[#52d6bd]/25 border-[#52d6bd]/70 text-[#52d6bd]"
                      : "border-transparent text-[#9bafbc] hover:text-white"
                  }`}
                >
                  ◀ ЛЗ
                </button>
                <button
                  type="button"
                  data-testid="head-detent-road"
                  aria-pressed={headDetentUi === "road"}
                  onClick={() => {
                    sceneCtrlRef.current?.setHeadDetent(0);
                    setHeadDetentUi("road");
                    onNotify("Взгляд: дорога + салонное зеркало");
                  }}
                  className={`px-1.5 py-1 rounded text-[10px] font-bold border transition ${
                    headDetentUi === "road"
                      ? "bg-[#f5b942]/25 border-[#f5b942]/70 text-[#f5b942]"
                      : "border-transparent text-[#9bafbc] hover:text-white"
                  }`}
                >
                  Дорога
                </button>
                <button
                  type="button"
                  data-testid="head-detent-right"
                  aria-pressed={headDetentUi === "right"}
                  onClick={() => {
                    sceneCtrlRef.current?.setHeadDetent(-1);
                    setHeadDetentUi("right");
                    onNotify("Взгляд: правое зеркало");
                  }}
                  className={`px-1.5 py-1 rounded text-[10px] font-bold border transition ${
                    headDetentUi === "right"
                      ? "bg-[#52d6bd]/25 border-[#52d6bd]/70 text-[#52d6bd]"
                      : "border-transparent text-[#9bafbc] hover:text-white"
                  }`}
                >
                  ПЗ ▶
                </button>
              </div>
              <button
                type="button"
                data-testid="cockpit-look-shifter"
                onClick={toggleShifterGlance}
                title="Направить взгляд на 3D-рычаг АКПП в салоне и обратно на дорогу (клавиша G или ПКМ вниз-вправо)"
                className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                  shifterGlance
                    ? "bg-[#f5b942]/25 border-[#f5b942]/70 text-[#f5b942]"
                    : "bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#c5d4de] hover:text-white"
                }`}
              >
                {shifterGlance ? "↑ Дорога (G)" : "Рычаг КПП (G)"}
              </button>
              <button
                type="button"
                data-testid="cockpit-look-headunit"
                title={"Направить взгляд на 7\" ШГУ в салоне и обратно на дорогу"}
                onClick={() => {
                  if (optsRef.current.cameraMode !== "cockpit") return;
                  setShifterGlance(false);
                  sceneCtrlRef.current?.lookAtHeadUnit();
                  onNotify("Взгляд на 7\" ШГУ: кликайте по экрану, шайбам VOL/TUNE и кнопкам на торпедо");
                }}
                className="px-2 py-1 rounded-lg text-[10px] font-bold border bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#c5d4de] hover:text-white"
              >
                ШГУ
              </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowTrajectory((v) => !v)}
              className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                showTrajectory
                  ? "bg-[#52d6bd]/20 border-[#52d6bd]/50 text-[#52d6bd]"
                  : "bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#8fa2ae]"
              }`}
              title="Показать дугу движения габаритов по Аккерману"
            >
              Траектория
            </button>
            <button
              type="button"
              onClick={toggleSideMirrors}
              className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                showMirrors && !(isPanelClosed("mirrorLeft") && isPanelClosed("mirrorRight"))
                  ? "bg-[#52d6bd]/20 border-[#52d6bd]/50 text-[#52d6bd]"
                  : "bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#8fa2ae]"
              }`}
              title="Боковые зеркала (2:1) — отключите для прироста FPS"
            >
              Боковые
            </button>
            <button
              type="button"
              onClick={toggleRearMirror}
              className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                showRearMirror && !isPanelClosed("mirrorRear")
                  ? "bg-[#52d6bd]/20 border-[#52d6bd]/50 text-[#52d6bd]"
                  : "bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#8fa2ae]"
              }`}
              title="Зеркало заднего вида (3.33:1) — включается и выключается отдельно"
            >
              Заднее
            </button>
            <button
              type="button"
              onClick={() =>
                setQuality((q) => (q === "low" ? "medium" : q === "medium" ? "high" : "low"))
              }
              className="px-2 py-1 rounded-lg text-[10px] font-bold border bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#9bafbc]"
              title="Профиль графики для слабого GPU"
            >
              Графика: {quality === "low" ? "Низк" : quality === "medium" ? "Сред" : "Выс"}
            </button>
            </div>
          </FloatingPanel>
        )}

        {/* [SEC:sim-cluster] Приборная панель, селектор АКПП, кнопки I/РН/B/L и раздельные педали */}
        {!uiHidden && !isPanelClosed("cluster") && (
          <FloatingPanel
            id="cluster"
            label="Приборы и КПП"
            collapsedSummary={`${kmh} км/ч · ${gearDisplay}`}
            collapsed={isPanelCollapsed("cluster")}
            onToggleCollapse={handleToggleCollapse}
            onClose={handleClosePanel}
            layout={layout.cluster}
            defaults={(cw, ch) => {
              const w = Math.min(620, cw - 16);
              return { x: (cw - w) / 2, y: ch - (cw < 720 ? 185 : cw < 960 ? 160 : 82), w };
            }}
            minW={330}
            maxW={880}
            onChange={handleLayoutChange}
            onBringToFront={handleBringPanelToFront}
            isFront={isFrontPanel("cluster")}
            containerRef={containerRef}
            zIndex={panelZ("cluster", 22)}
          >
            <div className="px-3 py-2 flex flex-wrap items-center justify-center gap-2 sm:gap-3 pr-7">
              {/* Левый поворотник */}
              <button
                type="button"
                onClick={() => {
                  setTurnSignal(inputRef.current.signal === "left" ? null : "left");
                }}
                className={`h-8 w-8 rounded-lg border font-bold text-sm transition ${
                  leftBlink
                    ? "bg-[#f5b942] text-[#17130a] border-[#f5b942]"
                    : s.signal === "left"
                      ? "border-[#f5b942]/60 text-[#f5b942]"
                      : "border-[rgba(148,176,194,.2)] text-[#7c909d]"
                }`}
                title="Левый поворотник (Q, +X)"
              >
                ◀
              </button>

              {/* Спидометр + тахометр */}
              <div className="text-center min-w-[74px]">
                <div className="mono text-2xl font-bold leading-none">
                  {kmh}
                  <span className="text-[10px] text-[#7c909d] ml-1">км/ч</span>
                </div>
                <div className="h-1.5 w-20 mx-auto mt-1.5 rounded bg-[rgba(148,176,194,.14)] overflow-hidden">
                  <div
                    className={`h-full transition-[width,background-color] duration-75 ease-out ${
                      s.rpm >= SHIFT_HINT_RPM
                        ? "bg-[#ff6b6b]"
                        : s.rpm >= 4400
                          ? "bg-[#f5b942]"
                          : "bg-[#52d6bd]"
                    }`}
                    style={{ width: `${Math.min(100, (s.rpm / ENGINE_REDLINE_RPM) * 100)}%` }}
                  />
                </div>
                <div className="mono text-[9px] text-[#6e8492] mt-0.5">
                  {!s.engineOn && s.rpm < 20 ? (
                    "ЗАГЛУШЕН"
                  ) : shiftUpCue ? (
                    <span className="text-[#f5b942] font-bold">
                      {Math.round(s.rpm)} SHIFT▲
                    </span>
                  ) : (
                    `${Math.round(s.rpm)} об`
                  )}
                </div>
              </div>

              {/* Правый поворотник */}
              <button
                type="button"
                onClick={() => {
                  setTurnSignal(inputRef.current.signal === "right" ? null : "right");
                }}
                className={`h-8 w-8 rounded-lg border font-bold text-sm transition ${
                  rightBlink
                    ? "bg-[#f5b942] text-[#17130a] border-[#f5b942]"
                    : s.signal === "right"
                      ? "border-[#f5b942]/60 text-[#f5b942]"
                      : "border-[rgba(148,176,194,.2)] text-[#7c909d]"
                }`}
                title="Правый поворотник (E, −X)"
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => {
                  setTurnSignal(inputRef.current.signal === "hazard" ? null : "hazard");
                }}
                className={`h-8 w-8 rounded-lg border grid place-items-center transition ${
                  leftBlink && rightBlink
                    ? "bg-[#f5b942] text-[#17130a] border-[#f5b942]"
                    : s.signal === "hazard"
                      ? "border-[#f5b942]/60 text-[#f5b942]"
                      : "border-[rgba(148,176,194,.2)] text-[#7c909d]"
                }`}
                title="Аварийная сигнализация (Z)"
                aria-label="Аварийная сигнализация"
              >
                <Icon name="alert" size={14} />
              </button>

              {/* Селектор 6-ст. КПП Shiftronic: P / R / N / D (D1–D6) + ручной Shift (M1–M6) с подсказкой при наведении */}
              <div
                data-testid="hud-gear-selector"
                onPointerLeave={() => setHudGearHint(null)}
                className="flex items-center gap-1 border-l hairline pl-2.5"
              >
                {(["P", "R", "N", "D"] as const).map((g) => {
                  const isDriveSlot = g === "D";
                  const active = s.gear === g || (isDriveSlot && manualMode);
                  // Shift Lock: селектор заперт электромагнитом (ДВС заглушен или в P без тормоза)
                  const lock =
                    g === "P"
                      ? shiftLockState({ ...inputRef.current, brake: s.brakePos ?? 0 }, s.v)
                      : null;
                  const shiftLocked = Boolean(lock?.locked);
                  const showHint = (el: HTMLElement) => {
                    const host = containerRef.current;
                    if (!host) return;
                    const hr = host.getBoundingClientRect();
                    const br = el.getBoundingClientRect();
                    const boxW = Math.min(316, Math.max(240, hr.width - 16));
                    const centerX = br.left - hr.left + br.width / 2;
                    const left = clamp(centerX - boxW / 2, 8, Math.max(8, hr.width - boxW - 8));
                    const spaceAbove = br.top - hr.top;
                    const below = spaceAbove < 190;
                    const top = below ? br.bottom - hr.top + 8 : br.top - hr.top - 8;
                    setHudGearHint({ slot: g, left, top, below });
                  };
                  return (
                    <button
                      key={g}
                      type="button"
                      data-gear-slot={g}
                      onClick={() => setGear(g)}
                      onPointerEnter={(e) => showHint(e.currentTarget)}
                      onFocus={(e) => showHint(e.currentTarget)}
                      onBlur={() => setHudGearHint(null)}
                      onContextMenu={
                        isDriveSlot
                          ? (e) => {
                              e.preventDefault();
                              shiftGear(1);
                            }
                          : undefined
                      }
                      data-shift-locked={g === "P" ? String(shiftLocked) : undefined}
                      title={
                        g === "P" && shiftLocked
                          ? lock?.hint
                          : g === "P"
                            ? "P — парковка (выход из P только с нажатым тормозом)"
                            : undefined
                      }
                      aria-label={
                        g === "P"
                          ? shiftLocked
                            ? `P — парковка, селектор заперт: ${lock?.hint}`
                            : "P — парковка"
                          : g === "R"
                            ? "R — задний ход"
                            : g === "N"
                              ? "N — нейтраль"
                              : manualMode
                                ? `D — вернуть автомат из ${gearDisplay}`
                                : "D — автомат D1–D6"
                      }
                      className={`mono relative h-8 min-w-[30px] px-2 rounded-lg text-xs font-bold border transition ${
                        active
                          ? g === "P"
                            ? "bg-[#94a3b8] text-[#081512] border-[#94a3b8]"
                            : g === "R" || (isDriveSlot && manualMode)
                              ? "bg-[#f5b942] text-[#17130a] border-[#f5b942]"
                              : "bg-[#52d6bd] text-[#081512] border-[#52d6bd]"
                          : "border-[rgba(148,176,194,.2)] text-[#8fa2ae] hover:text-white"
                      }`}
                    >
                      {active && isDriveSlot ? gearDisplay : g}
                      {g === "P" && shiftLocked && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -right-0.5 -top-0.5 text-[8px] leading-none text-[#f5b942]"
                        >
                          🔒
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Индикаторы-кнопки I / РН / B / L */}
              <div className="hidden md:flex items-center gap-1 border-l hairline pl-2.5">
                <button
                  type="button"
                  onClick={toggleEngine}
                  className={`mono px-2 h-8 rounded-lg text-[10px] font-bold border ${
                    s.engineOn
                      ? "border-[#52d6bd]/50 text-[#52d6bd] bg-[#52d6bd]/10"
                      : "border-[#ff6b6b]/50 text-[#ff6b6b]"
                  }`}
                  title="Запуск ДВС только из P или N; заглушить можно в любом режиме (I)"
                >
                  ДВС
                </button>
                <button
                  type="button"
                  onClick={() => {
                    inputRef.current.handbrake = !inputRef.current.handbrake;
                  }}
                  className={`mono px-2 h-8 rounded-lg text-[10px] font-bold border ${
                    s.handbrake
                      ? "border-[#ff6b6b]/60 text-[#ff6b6b] bg-[#ff6b6b]/12"
                      : "border-[rgba(148,176,194,.2)] text-[#7c909d]"
                  }`}
                  title="Стояночный тормоз / ручник (Space) — не путать с передачей P"
                >
                  РУЧ
                </button>
                <button
                  type="button"
                  onClick={() => {
                    inputRef.current.belt = !inputRef.current.belt;
                  }}
                  className={`mono px-2 h-8 rounded-lg text-[10px] font-bold border ${
                    s.belt
                      ? "border-[#52d6bd]/50 text-[#52d6bd] bg-[#52d6bd]/10"
                      : "border-[#f5b942]/60 text-[#f5b942] bg-[#f5b942]/10"
                  }`}
                  title="Ремень безопасности (B)"
                >
                  РЕМ
                </button>
                <button
                  type="button"
                  onClick={() => {
                    inputRef.current.lights = !inputRef.current.lights;
                  }}
                  className={`mono px-2 h-8 rounded-lg text-[10px] font-bold border ${
                    s.lights
                      ? "border-[#52d6bd]/50 text-[#52d6bd] bg-[#52d6bd]/10"
                      : "border-[rgba(148,176,194,.2)] text-[#7c909d]"
                  }`}
                  title="Ближний свет фар (L)"
                >
                  СВЕТ
                </button>
              </div>
            </div>
          </FloatingPanel>
        )}

        {/* Две независимые панели педалей: перенос за grip, сворачивание − и закрытие × над рабочей зоной */}
        {!uiHidden && (["brake", "gas"] as const).map((which) => {
          const gas = which === "gas";
          const id = gas ? "pedalGas" : "pedalBrake";
          if (isPanelClosed(id)) return null;
          const width = gas ? 76 : 84;
          const pLabel = gas ? "Педаль газа" : "Педаль тормоза";
          return (
            <FloatingPanel key={id} id={id} activation="grip" resizable={false}
              label={pLabel}
              collapsedSummary={gas ? "ГАЗ (W)" : "ТОРМ (S)"}
              collapsed={isPanelCollapsed(id)}
              onToggleCollapse={handleToggleCollapse}
              onClose={handleClosePanel}
              gripLabel={gas ? "Переместить педаль газа" : "Переместить педаль тормоза"}
              layout={layout[id]} defaults={(cw, ch) => ({
                x: Math.max(0, cw - 12 - width - (gas ? 0 : 86)), y: Math.max(0, ch - 98), w: width,
              })}
              minW={width} maxW={width} onChange={handleLayoutChange} onBringToFront={handleBringPanelToFront}
              isFront={isFrontPanel(id)} containerRef={containerRef} zIndex={panelZ(id, 27)}>
              <button type="button" {...bindPedal(which)} aria-label={gas ? "Газ" : "Тормоз"}
                aria-pressed={pedalVisual[which]} title={gas ? "Газ: удерживайте кнопку или W" : "Тормоз: удерживайте кнопку или S"}
                className={`pedal-face ${gas ? "pedal-gas" : "pedal-brake"}`}>
                <span className="pedal-tread" aria-hidden="true" />
                <span className="pedal-caption">{gas ? "ГАЗ" : "ТОРМОЗ"}<kbd>{gas ? "W" : "S"}</kbd></span>
              </button>
            </FloatingPanel>
          );
        })}

        {/* Всплывающая подсказка по переключению 6АКПП Shiftronic при наведении на селектор HUD */}
        {!uiHidden && hudGearHint && (
          <div
            role="tooltip"
            data-testid="hud-gearbox-hint"
            style={{
              left: hudGearHint.left,
              top: hudGearHint.top,
              transform: hudGearHint.below ? "none" : "translateY(-100%)",
            }}
            className="pointer-events-none absolute z-[92] w-[min(316px,calc(100%-16px))] rounded-xl border border-[#52d6bd]/35 bg-[#070d14]/95 px-3 py-2.5 text-[11px] leading-snug text-[#c5d4de] shadow-2xl backdrop-blur"
          >
            <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-white/10">
              <span className="mono text-[10px] font-extrabold text-[#52d6bd]">6АКПП SHIFTRONIC · ПОДСКАЗКА</span>
              <span
                className={`mono px-1.5 py-0.5 rounded text-[10px] font-extrabold ${
                  manualMode
                    ? "bg-[#f5b942]/20 text-[#f5b942]"
                    : s.gear === "D"
                      ? "bg-[#52d6bd]/20 text-[#52d6bd]"
                      : s.gear === "R"
                        ? "bg-[#ff6b6b]/20 text-[#ff8a8a]"
                        : "bg-white/10 text-white"
                }`}
              >
                Сейчас: {gearDisplay}
              </span>
            </div>

            <div className="text-[11px] font-semibold text-white mb-1.5">
              {hudGearHint.slot === "P" && "P (Парковка) — блокировка колёс, только на полной остановке (S)."}
              {hudGearHint.slot === "R" && "R (Задний ход) — движение назад до 14 км/ч + камера заднего вида."}
              {hudGearHint.slot === "N" && "N (Нейтраль) — колёса разобщены с ДВС, разрешён запуск (I)."}
              {hudGearHint.slot === "D" &&
                (manualMode
                  ? `Активен ручной ${gearDisplay}: ЛКМ по кнопке или F — вернуть автомат D; ПКМ — +1.`
                  : "D (Автомат D1–D6) — коробка сама меняет 6 ступеней; ПКМ — ручной +1.")}
            </div>

            <div className="space-y-1 text-[10.5px] text-[#a9bcc8]">
              <div>
                <span className="mono font-bold text-[#f5b942]">P · R · N · F</span> — прямой выбор{" "}
                <span className="text-white">P / R / N / Авто D</span>{" "}
                <span className="text-[#52d6bd]">(F или клик D возвращает D из M)</span>
              </div>
              <div>
                <span className="mono font-bold text-[#f5b942]">Shift Lock (BTSI)</span> — выход из P и запуск{" "}
                <span className="text-white">только с нажатой педалью тормоза</span>{" "}
                <span className="text-[#52d6bd]">(S / экранная педаль)</span>
              </div>
              <div>
                <span className="mono font-bold text-[#f5b942]">Shift+↑ / Shift+↓</span> — ручной паз{" "}
                <span className="text-white">M1–M6</span> (защита от перекрута и заглохания)
              </div>
              <div>
                <span className="mono font-bold text-[#f5b942]">В салоне (2 · G)</span> — перетаскивайте или кликайте{" "}
                <span className="text-white">3D-рычаг АКПП</span> (влево — M +/−, вправо — D)
              </div>
              {!s.engineOn && (
                <div className="text-[#f5b942] pt-0.5">Сначала запустите двигатель клавишей I (в P или N).</div>
              )}
            </div>
          </div>
        )}

        {/* Всплывающая подсказка по органу салона: 7" ШГУ, VOL/TUNE, аварийка, START/STOP, свет, подрулевой, ручник */}
        {!uiHidden && cameraMode === "cockpit" && cockpitControlUi && (() => {
          const cw = containerRef.current?.clientWidth ?? 960;
          const ch = containerRef.current?.clientHeight ?? 600;
          const cardW = Math.min(300, Math.max(228, cw - 16));
          const preferRight = cockpitControlUi.x + 22 + cardW <= cw - 8;
          const left = preferRight ? cockpitControlUi.x + 22 : Math.max(8, cockpitControlUi.x - cardW - 18);
          const top = clamp(cockpitControlUi.y - 76, 10, Math.max(10, ch - 150));
          const info: Record<CockpitControlId, { title: string; action: string; hint: string }> = {
            headunit: {
              title: "7\" ШГУ · сенсорный экран",
              action: "Клик — сменить режим: ассистент → радио → клип → выкл.",
              hint: HEAD_UNIT_MODES.find((m) => m.id === headUnit.mode)?.label ?? "",
            },
            vol: {
              title: "Шайба VOL · громкость",
              action: headUnit.radioPlaying ? "Клик — пауза радио" : "Клик — включить радио",
              hint: `FM ${radioStations[clamp(headUnit.stationIndex, 0, radioStations.length - 1)].freq} · ${radioStations[clamp(headUnit.stationIndex, 0, radioStations.length - 1)].name}`,
            },
            tune: {
              title: "Шайба TUNE · настройка",
              action: "Клик — следующая станция FM",
              hint: `${radioStations.length} станций в списке сценария`,
            },
            hazard: {
              title: "Аварийная сигнализация",
              action: "Клик — включить/выключить (Z)",
              hint: "Кнопка ▲ под 7\" экраном ШГУ",
            },
            start: {
              title: "ENGINE START / STOP",
              action: "Клик — запуск/остановка ДВС (I)",
              hint: "Запуск только из P или N, выход из P — с тормозом",
            },
            headlight: {
              title: "Переключатель света",
              action: "Клик — ближний свет фар (L)",
              hint: "Поворотный барабан слева от рулевой колонки",
            },
            "stalk-left": {
              title: "Левый подрулевой переключатель",
              action: "Клик — левый → правый → выкл. (Q / E)",
              hint: "",
            },
            handbrake: {
              title: "Рычаг стояночного тормоза",
              action: "Клик — затянуть/снять ручник (Space)",
              hint: "",
            },
            horn: {
              title: "Сигнал · накладка руля",
              action: "Клик — короткий «би-бип»; удержание H — длинный клаксон",
              hint: soundLayers.horn ? "Двухтональный 415/500 Гц" : "Слой «Сигнал» выключен в настройках звука",
            },
          };
          const item = info[cockpitControlUi.id];
          return (
            <div
              role="tooltip"
              data-testid="cockpit-control-hint"
              data-control={cockpitControlUi.id}
              style={{ left, top }}
              className="pointer-events-none absolute z-[92] w-[min(300px,calc(100%-16px))] rounded-xl border border-[#52d6bd]/45 bg-[#070d14]/95 px-3 py-2.5 text-[11px] leading-snug text-[#c5d4de] shadow-2xl backdrop-blur"
            >
              <div className="mono text-[10px] font-extrabold text-[#52d6bd] pb-1 mb-1 border-b border-white/10">
                {item.title}
              </div>
              <div className="text-[11px] text-[#dbe7ee]">{item.action}</div>
              {item.hint && <div className="mt-0.5 text-[10px] text-[#9bafbc]">{item.hint}</div>}
            </div>
          );
        })()}

        {/* Всплывающая подсказка и живая схема кулисы при наведении/перетаскивании 3D-рычага АКПП в салоне */}
        {cameraMode === "cockpit" && cockpitShifterUi && (() => {
          const cw = containerRef.current?.clientWidth ?? 960;
          const ch = containerRef.current?.clientHeight ?? 600;
          const cardW = Math.min(312, Math.max(236, cw - 16));
          const preferRight = cockpitShifterUi.x + 22 + cardW <= cw - 8;
          const left = preferRight
            ? cockpitShifterUi.x + 22
            : Math.max(8, cockpitShifterUi.x - cardW - 18);
          const top = clamp(cockpitShifterUi.y - 84, 10, Math.max(10, ch - 196));
          const zoneLabel: Record<ShifterHitId, string> = {
            lever: cockpitShifterUi.dragging ? "Перемещение рычага" : "Рукоятка рычага",
            P: "Паз P · Парковка",
            R: "Паз R · Задний ход",
            N: "Паз N · Нейтраль",
            D: "Паз D · Автомат D1–D6",
            M: "Паз M · Ручной Shiftronic",
            "M+": "Качание + · Передача ▲",
            "M-": "Качание − · Передача ▼",
          };
          return (
            <div
              role="tooltip"
              data-testid="cockpit-shifter-hint"
              style={{ left, top }}
              className="pointer-events-none absolute z-[92] w-[min(312px,calc(100%-16px))] rounded-xl border border-[#f5b942]/45 bg-[#070d14]/95 px-3 py-2.5 text-[11px] leading-snug text-[#c5d4de] shadow-2xl backdrop-blur"
            >
              <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-white/10">
                <span className="mono text-[10px] font-extrabold text-[#f5b942]">3D-РЫЧАГ 6АКПП · {zoneLabel[cockpitShifterUi.hit]}</span>
                <span className="mono px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-extrabold text-white">
                  {gearDisplay}
                </span>
              </div>

              {/* Наглядная мини-схема кулисы P – R – N – D ⇄ M (+/−) */}
              <div className="flex items-center justify-between gap-1.5 mb-1.5 rounded-lg bg-[#0c1520] border hairline px-2 py-1 mono text-[10px]">
                <div className="flex items-center gap-1">
                  {(["P", "R", "N", "D"] as const).map((slot) => {
                    const cur = s.gear === slot;
                    const aim = cockpitShifterUi.hit === slot;
                    return (
                      <span
                        key={slot}
                        className={`px-1.5 py-0.5 rounded font-extrabold ${
                          cur
                            ? slot === "D"
                              ? "bg-[#52d6bd] text-[#071512]"
                              : slot === "R"
                                ? "bg-[#ff6b6b] text-[#1a0707]"
                                : "bg-[#cbd5e1] text-[#0b1118]"
                            : aim
                              ? "border border-[#52d6bd]/60 text-white"
                              : "text-[#7c909d]"
                        }`}
                      >
                        {slot === "D" && cur ? gearDisplay : slot}
                      </span>
                    );
                  })}
                </div>
                <span className="text-[#64748b]">⇄</span>
                <div className="flex items-center gap-1">
                  <span className={cockpitShifterUi.hit === "M-" ? "text-[#f5b942] font-extrabold" : "text-[#7c909d]"}>−</span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-extrabold ${
                      manualMode
                        ? "bg-[#f5b942] text-[#17130a]"
                        : cockpitShifterUi.hit === "M"
                          ? "border border-[#f5b942]/60 text-[#f5b942]"
                          : "text-[#9bafbc]"
                    }`}
                  >
                    {manualMode ? gearDisplay : "M"}
                  </span>
                  <span className={cockpitShifterUi.hit === "M+" ? "text-[#f5b942] font-extrabold" : "text-[#7c909d]"}>+</span>
                </div>
              </div>

              <div className="space-y-0.5 text-[10.5px] text-[#a9bcc8]">
                <div>
                  <span className="text-white font-semibold">ЛКМ вверх/вниз</span> (или клик по пазу) —{" "}
                  <span className="mono text-[#52d6bd]">P ↔ R ↔ N ↔ D</span>
                </div>
                <div>
                  <span className="text-white font-semibold">Из D влево</span> (к себе) —{" "}
                  <span className="mono text-[#f5b942]">M1–M6</span>: вперёд <span className="mono text-white">+</span>, назад{" "}
                  <span className="mono text-white">−</span>
                </div>
                <div>
                  <span className="text-white font-semibold">Из M вправо</span> (клик <span className="mono text-white">D</span> или{" "}
                  <span className="mono text-[#52d6bd]">F</span>) — возврат в автомат{" "}
                  <span className="mono text-[#52d6bd]">D1–D6</span>
                </div>
                <div>
                  <span className="text-white font-semibold">Колесо</span> — шаг передачи ·{" "}
                  <span className="mono text-[#f5b942]">Shift+↑ / Shift+↓</span> ·{" "}
                  <span className="mono text-[#9bafbc]">G</span> — дорога
                </div>
                {!s.engineOn ? (
                  <div className="text-[#f5b942] pt-0.5">ДВС заглушен — селектор заперт, нажмите I (в P/N).</div>
                ) : (
                  s.gear === "P" && (
                    <div className={`pt-0.5 ${(s.brakePos ?? 0) < 0.1 ? "text-[#f5b942]" : "text-[#52d6bd]"}`}>
                      {(s.brakePos ?? 0) < 0.1
                        ? "SHIFT LOCK: зажмите тормоз S, чтобы снять рычаг с P."
                        : "Тормоз нажат — рычаг можно вывести из P."}
                    </div>
                  )
                )}
              </div>
            </div>
          );
        })()}

        {/* В режиме H на экране остаются только зеркала (и 3D-салон с интерактивным рычагом АКПП). Вернуть HUD — H. */}
      </div>

      {/* Компактная нижняя строка метаданных (сворачиваемая, атрибуция ODbL сохраняется всегда) */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#7c909d] px-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={footerCollapsed ? "Развернуть строку сведений" : "Свернуть строку сведений"}
            title={footerCollapsed ? "Развернуть сведения об автомобиле и правилах" : "Свернуть строку сведений"}
            onClick={() => setFooterCollapsed((v) => !v)}
            className="mono h-5 px-1.5 rounded border hairline text-[10px] text-[#8fa2ae] hover:text-[#f5b942] cursor-pointer"
          >
            {footerCollapsed ? "+ Сведения" : "−"}
          </button>
          {!footerCollapsed && (
            <>
              <Chip tone="neutral">
                {getPlayerCar(hud.state.carId).name} · {getPlayerCar(hud.state.carId).length.toFixed(2)}×
                {getPlayerCar(hud.state.carId).width.toFixed(2)} м · Выворот {wheelLimit.toLocaleString("ru-RU")}°
              </Chip>
              <Chip tone={ruleSet.status === "instructor_signed" ? "mint" : "amber"}>
                Правила: {ruleSet.version} ({ruleSet.status === "instructor_signed" ? "подписано" : "демо"})
              </Chip>
              <span>{world.subtitle}</span>
              {street && (
                <span className="mono text-[#52d6bd] flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#52d6bd]" />
                  ул.: {street.name}
                  {street.limitKmh ? ` · ${street.limitKmh} км/ч` : ""}
                </span>
              )}
            </>
          )}
        </div>
        <div className="mono text-[10px] text-[#8fa2ae]">
          {world.mapMeta
            ? `Данные карты ${world.mapMeta.attribution} (${world.mapMeta.license}) · офлайн`
            : "Учебный тренажёр · не заменяет экзамен в ГИБДД"}
        </div>
      </div>
    </div>
  );
}
