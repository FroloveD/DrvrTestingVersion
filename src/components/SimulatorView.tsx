/**
 * @module components/SimulatorView
 * @layer ui
 * @role Главный экран 3D-тренажёра: выбор пяти Kia, цикл 1/60 с, 6-ступенчатая КПП, запись заезда, зеркала и перемещаемые панели HUD.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyBindingsEditor } from "./KeyBindingsEditor";
import { HeadUnitPanel } from "./HeadUnitPanel";
import { DEFAULT_HEAD_UNIT_STATE, type HeadUnitState } from "../render/cockpitDisplays";
import { loadKeyBindings, logicalKey, type KeyBindings } from "../input/keyBindings";
import { EngineSound } from "../audio/engineSound";
import { loadGamepadProfile, readBrowserGamepad, saveGamepadProfile } from "../input/browserGamepads";
import { createAxisArming, readGamepad, updateAxisArming, type GamepadProfile } from "../input/gamepad";
import { parseMapFileText, type NormalizedOsmPack } from "../maps/osmLoader";
import { streetNameAt } from "../maps/route";
import { SceneController, type PerfMetrics } from "../render/sceneController";
import { buildScenarioWorld } from "../scenarios/catalog";
import type { CustomScenarioDef } from "../scenarios/custom";
import { evaluateAttempt, type EvaluationResult, type RuleSet } from "../scoring/rules";
import { applyShifterTarget, checkEngineToggle, checkGearChange, stepGearSequential, stepShifterGate, type ShifterTarget } from "../sim/controls";
import { AttemptRecorder, quantizeInput, type RecordedAttempt } from "../sim/recorder";
import { SpatialGrid } from "../sim/spatialGrid";
import { createInitialInput, createInitialState, createReadyInput, defaultGearForWorld, stepSimulation } from "../sim/step";
import type {
  CalibrationConfig,
  CameraMode,
  Gear,
  InputState,
  QualityPreset,
  PlayerCarId,
  ScenarioId,
  SimEvent,
  SimState,
  WorldData,
} from "../sim/types";
import { getPlayerCar, PLAYER_CARS } from "../sim/playerCar";
import {
  carGeometry,
  clamp,
  FIXED_DT,
  getCarCorners,
  getTrafficLightPhase,
  getTurnSignalFlash,
  isManualGear,
  normalizeWheelLock,
  STEER_WHEEL,
} from "../sim/vehicle";
import { Chip, Icon } from "./Icons";
import { FloatingPanel, loadLayout, saveLayout, type LayoutMap, type PanelLayout } from "./FloatingPanel";
import { GamepadPanel } from "./GamepadPanel";
import { SteeringLimitControl } from "./SteeringLimitControl";
import { SHIFTER_LAYOUT, type ShifterHitId } from "../render/vehiclesAndPeds";

type Props = {
  /** Тренажёр примонтирован всегда, но работает, пока его вкладка активна */
  active: boolean;
  immersive: boolean;
  onToggleImmersive: () => void;
  scenarioId: ScenarioId;
  onScenarioChange: (id: ScenarioId) => void;
  calibration: CalibrationConfig;
  onWheelLockChange: (deg: number) => void;
  ruleSet: RuleSet;
  customOsm: NormalizedOsmPack | null;
  onCustomOsmChange: (pack: NormalizedOsmPack | null) => void;
  customDef: CustomScenarioDef;
  onAttemptSaved: (attempt: RecordedAttempt, openDebrief: boolean, quiet?: boolean) => void;
  onNotify: (msg: string) => void;
};

// === [SEC:sim-storage] Настройки клавиатурного руля и 2D-fallback без WebGL ===
const CONTROLS_KEY = "cdt.controls.v1";
const DEFAULT_STEER_KEY_RATE = 340;
/** Старт и сброс попытки всегда «холодные»: ДВС заглушен, КПП P. */
const COLD_START = false;

type MouseSteerMode = "free" | "hold";

function loadControls(): { steerKeyRate: number; mouseSteerEnabled: boolean; mouseSteerMode: MouseSteerMode; mouseGasEnabled: boolean } {
  try {
    const raw = localStorage.getItem(CONTROLS_KEY);
    const parsed = raw ? (JSON.parse(raw) as { steerKeyRate?: number; mouseSteerEnabled?: boolean; mouseSteerMode?: MouseSteerMode; mouseGasEnabled?: boolean }) : {};
    const rate = Number(parsed.steerKeyRate);
    return {
      steerKeyRate: Number.isFinite(rate) ? clamp(rate, 60, 900) : DEFAULT_STEER_KEY_RATE,
      mouseSteerEnabled: parsed.mouseSteerEnabled === true,
      // Старые настройки продолжают работать в прежнем свободном режиме.
      mouseSteerMode: parsed.mouseSteerMode === "hold" ? "hold" : "free",
      mouseGasEnabled: parsed.mouseGasEnabled === true,
    };
  } catch {
    return { steerKeyRate: DEFAULT_STEER_KEY_RATE, mouseSteerEnabled: false, mouseSteerMode: "free", mouseGasEnabled: false };
  }
}

function saveControls(c: { steerKeyRate: number; mouseSteerEnabled: boolean; mouseSteerMode: MouseSteerMode; mouseGasEnabled: boolean }): void {
  try {
    localStorage.setItem(CONTROLS_KEY, JSON.stringify(c));
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

  // Автомобиль игрока
  const corners = getCarCorners(s.x, s.z, s.h, carGeometry(s.carId));
  ctx.fillStyle = "#f5b942";
  ctx.beginPath();
  corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.z) : ctx.lineTo(c.x, c.z)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// === [SEC:sim-state] Состояние компонента, рефы симуляции, раскладка и геймпад ===
export function SimulatorView({
  active,
  immersive,
  onToggleImmersive,
  scenarioId,
  onScenarioChange,
  calibration,
  onWheelLockChange,
  ruleSet,
  customOsm,
  onCustomOsmChange,
  customDef,
  onAttemptSaved,
  onNotify,
}: Props) {
  const activeRef = useRef(true);
  const { perpBayWidth, perpBayLength, aisleWidth, parBayLength, parBayWidth } = calibration;
  // Новое значение выворота не изменяет площадку и не должно сбрасывать двигатель, позу или запись.
  const [playerCarId, setPlayerCarId] = useState<PlayerCarId>("ceed");
  const world = useMemo(
    () => ({ ...buildScenarioWorld(scenarioId, { perpBayWidth, perpBayLength, aisleWidth, parBayLength, parBayWidth }, customOsm, customDef), playerCarId }),
    [scenarioId, customOsm, customDef, perpBayWidth, perpBayLength, aisleWidth, parBayLength, parBayWidth, playerCarId]
  );
  const wheelLimit = normalizeWheelLock(calibration.maxInnerWheelDeg);

  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  const [shifterGlance, setShifterGlance] = useState(false);
  useEffect(() => {
    if (cameraMode !== "cockpit") {
      setShifterGlance(false);
      sceneCtrlRef.current?.resetHeadLook();
      sceneCtrlRef.current?.setShifterInteraction(null, false, 0);
    }
  }, [cameraMode]);
  const [quality, setQuality] = useState<QualityPreset>("medium");
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [showMirrors, setShowMirrors] = useState(true);
  const [showRearMirror, setShowRearMirror] = useState(true);
  const [uiHidden, setUiHidden] = useState(false);
  const [headUnit, setHeadUnit] = useState<HeadUnitState>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cdt.headUnit.v1") || "null") as Partial<HeadUnitState> | null;
      return saved ? { ...DEFAULT_HEAD_UNIT_STATE, ...saved, radioPlaying: false, streamStatus: "idle" } : DEFAULT_HEAD_UNIT_STATE;
    } catch {
      return DEFAULT_HEAD_UNIT_STATE;
    }
  });
  const [bindings, setBindings] = useState<KeyBindings>(loadKeyBindings);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const [showHelp, setShowHelp] = useState(false);
  const [showQuickStartPrompt, setShowQuickStartPrompt] = useState(true);
  const [quickStartUsed, setQuickStartUsed] = useState(false);
  const [webglFallback, setWebglFallback] = useState(false);
  const [pedalVisual, setPedalVisual] = useState<{ gas: boolean; brake: boolean }>({ gas: false, brake: false });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rearMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const leftMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const rightMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const wheelSvgRef = useRef<SVGSVGElement | null>(null);
  const wheelGroupRef = useRef<SVGGElement | null>(null);

  // Настраиваемая скорость руления клавишами A/D (°/с руля) и раскладка плавающих окон
  const [steerKeyRate, setSteerKeyRate] = useState<number>(() => loadControls().steerKeyRate);
  const [mouseSteerEnabled, setMouseSteerEnabled] = useState<boolean>(() => loadControls().mouseSteerEnabled);
  const [mouseSteerMode, setMouseSteerMode] = useState<MouseSteerMode>(() => loadControls().mouseSteerMode);
  const [mouseGasEnabled, setMouseGasEnabled] = useState<boolean>(() => loadControls().mouseGasEnabled);
  const steerRateRef = useRef<number>(steerKeyRate);
  const [showControls, setShowControls] = useState(false);
  const [layout, setLayout] = useState<LayoutMap>(loadLayout);

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
    saveControls({ steerKeyRate, mouseSteerEnabled, mouseSteerMode, mouseGasEnabled });
  }, [steerKeyRate, mouseSteerEnabled, mouseSteerMode, mouseGasEnabled]);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  useEffect(() => {
    try {
      localStorage.setItem("cdt.keybindings.v1", JSON.stringify(bindings));
    } catch {
      // Раскладка остаётся активной до закрытия вкладки, если storage недоступно.
    }
  }, [bindings]);

  const handleLayoutChange = useCallback((id: string, next: PanelLayout) => {
    setLayout((prev) => ({ ...prev, [id]: next }));
  }, []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Мутабельные рефы симуляционного цикла (без лишних ререндеров на 60 Гц)
  const sceneCtrlRef = useRef<SceneController | null>(null);
  const headUnitRef = useRef(headUnit);
  headUnitRef.current = headUnit;
  const engineSoundRef = useRef<EngineSound | null>(null);
  const lastEngineSoundAtRef = useRef(0);
  useEffect(() => {
    try {
      localStorage.setItem("cdt.headUnit.v1", JSON.stringify({ ...headUnit, radioPlaying: false, streamStatus: "idle" }));
    } catch {
      // Настройки мультимедиа остаются активными до закрытия вкладки.
    }
    sceneCtrlRef.current?.setHeadUnitState(headUnit);
  }, [headUnit]);

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
  // A cold-start idle screen is not an attempt until the learner explicitly starts it.
  const rideStartedRef = useRef(false);
  // Give a newly mounted/reset attempt a full autosave interval before its first draft write.
  const lastAutoSaveRef = useRef(Date.now());

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
      if (!recordingActiveRef.current || !rideStartedRef.current || !rideDirtyRef.current || autoSavedRef.current) return;
      rideDirtyRef.current = false;
      lastAutoSaveRef.current = Date.now();
      // Любой записанный тик сохраняется: движение может ещё не превысить порог hasMoved.
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
  const touchPedalRef = useRef<{ gas: boolean; brake: boolean }>({ gas: false, brake: false });
  const pedalOwner = useRef<{ gas: number | null; brake: number | null }>({ gas: null, brake: null });
  const canvasGasHoldTimerRef = useRef<number | null>(null);
  const canvasGasOwnerRef = useRef<number | null>(null);
  const holdingSteerRef = useRef(false);
  const pointerDragRef = useRef<{ id: number; btn: number; lastX: number; lastY: number } | null>(null);
  const mouseSteerXRef = useRef<number | null>(null);
  const throttleBoostRef = useRef<number>(1);
  const releasePedals = useCallback(() => {
    if (canvasGasHoldTimerRef.current !== null) {
      window.clearTimeout(canvasGasHoldTimerRef.current);
      canvasGasHoldTimerRef.current = null;
    }
    canvasGasOwnerRef.current = null;
    pointerDragRef.current = null;
    mouseSteerXRef.current = null;
    holdingSteerRef.current = false;
    pedalOwner.current = { gas: null, brake: null };
    touchPedalRef.current = { gas: false, brake: false };
    setPedalVisual({ gas: false, brake: false });
  }, []);
  useEffect(() => {
    if (!active || uiHidden || immersive) releasePedals();
  }, [active, uiHidden, immersive, releasePedals]);
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
    perf: { fps: 60, p95FrameMs: 16.6, visibleBuildings: 0, totalBuildings: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 },
    nextSignal: null,
    latestViolation: null,
  }));

  // === [SEC:sim-actions] Команды поворотников, АКПП, стартера и сброса попытки ===
  const setTurnSignal = useCallback((signal: InputState["signal"]) => {
    inputRef.current.signal = signal;
    // Reflect a signal button/key press immediately instead of waiting for the next HUD tick.
    setHud((current) => ({ ...current, state: { ...current.state, signal } }));
  }, []);

  /** Мгновенный сигнал тормоза для BTSI/Shift Lock, не дожидаясь следующего тика симуляции. */
  const liveBrakePressure = useCallback(() => {
    const keys = keysRef.current;
    return keys.KeyS || touchPedalRef.current.brake ? 1 : inputRef.current.brake;
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

  /** Ручное секвентальное переключение M1–M6; Shift+↑ повышает, Shift+↓ понижает ступень. */
  const shiftGear = useCallback((dir: 1 | -1) => {
    const inp = inputRef.current;
    const st = stateRef.current;
    const { next, blockedReason } = stepGearSequential({ ...inp, brake: liveBrakePressure() }, st.v, st.autoSubGear, dir);
    if (blockedReason) { onNotify(blockedReason); return; }
    if (!next) return;
    inp.gear = next;
    const nextSub = /^[1-6]$/.test(next) ? Number(next) : st.autoSubGear;
    setHud((current) => ({ ...current, state: { ...current.state, gear: next, autoSubGear: nextSub } }));
  }, [liveBrakePressure, onNotify]);



  const shifterNotifyAtRef = useRef(0);
  const notifyShifterOnce = useCallback((msg: string, throttle = false) => {
    const now = performance.now();
    if (throttle && now - shifterNotifyAtRef.current < 900) return;
    shifterNotifyAtRef.current = now;
    onNotify(msg);
  }, [onNotify]);

  const engageCockpitShifter = useCallback((target: ShifterTarget, fromDrag = false) => {
    const inp = inputRef.current;
    const st = stateRef.current;
    const { next, blockedReason } = applyShifterTarget(
      { ...inp, brake: liveBrakePressure() }, st.v, st.autoSubGear, target
    );
    if (blockedReason) { notifyShifterOnce(blockedReason, fromDrag); return null; }
    if (!next) return null;
    inp.gear = next;
    const nextSub = isManualGear(next) ? Number(next) : st.autoSubGear;
    setHud(current => ({ ...current, state: { ...current.state, gear: next, autoSubGear: nextSub } }));
    return next;
  }, [liveBrakePressure, notifyShifterOnce]);

  const stepCockpitShifter = useCallback((dir: 1 | -1) => {
    const inp = inputRef.current;
    const st = stateRef.current;
    const { next, blockedReason } = stepShifterGate(
      { ...inp, brake: liveBrakePressure() }, st.v, st.autoSubGear, dir
    );
    if (blockedReason) { notifyShifterOnce(blockedReason); return; }
    if (!next) return;
    inp.gear = next;
    const nextSub = isManualGear(next) ? Number(next) : st.autoSubGear;
    setHud(current => ({ ...current, state: { ...current.state, gear: next, autoSubGear: nextSub } }));
  }, [liveBrakePressure, notifyShifterOnce]);

  const toggleShifterGlance = useCallback(() => {
    if (cameraMode !== "cockpit") {
      setCameraMode("cockpit");
      sceneCtrlRef.current?.toggleCockpitShifterView();
      setShifterGlance(true);
      return;
    }
    const looking = sceneCtrlRef.current?.toggleCockpitShifterView() ?? false;
    setShifterGlance(looking);
  }, [cameraMode]);

  /** Запуск ДВС разрешён только в P или N (src/sim/controls.ts); заглушить можно в любом режиме. */
  const toggleEngine = useCallback(() => {
    const inp = inputRef.current;
    const err = checkEngineToggle(inp);
    if (err) {
      onNotify(err);
      return;
    }
    inp.engineOn = !inp.engineOn;
    if (!engineSoundRef.current) engineSoundRef.current = new EngineSound();
    engineSoundRef.current.ensureStarted();
    setHud((current) => ({
      ...current,
      state: { ...current.state, engineOn: inp.engineOn },
    }));
  }, [onNotify]);

  // Экшен-функции для цикла симуляции через ref (loop не пересоздаётся при их изменении)
  useEffect(() => {
    actionsRef.current = { toggleEngine, setGear, setTurnSignal };
  }, [toggleEngine, setGear, setTurnSignal]);

  const resetAttempt = useCallback(
    (targetWorld: WorldData, useReady: boolean) => {
      const defGear: Gear = defaultGearForWorld(targetWorld);
      const initState = createInitialState(targetWorld, useReady, calRef.current.maxInnerWheelDeg);
      stateRef.current = initState;
      inputRef.current = useReady ? createReadyInput(defGear) : createInitialInput();
      throttleBoostRef.current = 1;
      setShowQuickStartPrompt(true);
      setQuickStartUsed(false);
      gridRef.current = new SpatialGrid(targetWorld.obstacles, 10);
      recorderRef.current = new AttemptRecorder(initState, useReady);
      latestViolationRef.current = null;
      autoSavedRef.current = false;
      rideDirtyRef.current = false;
      recordingActiveRef.current = true;
      rideStartedRef.current = false;
      lastAutoSaveRef.current = Date.now();
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
      ctrl.setHeadUnitState(headUnitRef.current);
      ctrl.applyQuality(optsRef.current.quality);
      ctrl.loadWorld(worldRef.current);
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
        const gasPressed = Boolean(keys.KeyW || keys.ArrowUp || touchPedalRef.current.gas);
        const brakePressed = Boolean(keys.KeyS || keys.ArrowDown || touchPedalRef.current.brake);
        inp.throttle = Math.max(gasPressed ? 1 : 0, pad.throttle);
        inp.brake = Math.max(brakePressed ? 1 : 0, pad.brake);
        inp.shiftBoost = Boolean((keys.ShiftLeft || keys.ShiftRight) && inp.brake > 0.01);
        const boostTarget = (keys.ShiftLeft || keys.ShiftRight) && inp.throttle > 0 ? 2 : 1;
        throttleBoostRef.current += (boostTarget - throttleBoostRef.current) * Math.min(1, FIXED_DT * 3.5);
        inp.throttleMultiplier = throttleBoostRef.current;

        // Руль: отклонённое USB-устройство перехватывает управление у клавиатуры
        const cockpitLookMode = optsRef.current.cameraMode === "cockpit";
        const steerL = Boolean(keys.KeyA || (!cockpitLookMode && keys.ArrowLeft));
        const steerR = Boolean(keys.KeyD || (!cockpitLookMode && keys.ArrowRight));
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

      const soundNow = performance.now();
      if (soundNow - lastEngineSoundAtRef.current >= 55) {
        lastEngineSoundAtRef.current = soundNow;
        const soundState = stateRef.current;
        if (engineSoundRef.current) {
          engineSoundRef.current.update({
            engineOn: soundState.engineOn,
            rpm: soundState.rpm,
            throttle: inputRef.current.throttle,
            speedKmh: Math.abs(soundState.v) * 3.6,
          });
        }
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
            : { fps: 60, p95FrameMs: 16, visibleBuildings: 0, totalBuildings: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 },
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
      engineSoundRef.current?.dispose();
      engineSoundRef.current = null;
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
      // Слайдеру оставляем стрелки, Home и End. Клавиши вождения работают и после настройки.
      const drivingFromSlider = e.target instanceof HTMLInputElement && e.target.type === "range" && /^Key[A-Z]$/.test(e.code);
      if (isEditable(e.target) && !drivingFromSlider) return;
      const code = logicalKey(bindingsRef.current, e.code);
      if (code === "unbound") return;
      e.preventDefault();
      keysRef.current[code] = true;
      if (e.repeat) return;

      const inp = inputRef.current;
      const shiftHeld = Boolean(keysRef.current.ShiftLeft || keysRef.current.ShiftRight);
      if (shiftHeld && code === "ArrowUp") { shiftGear(1); return; }
      if (shiftHeld && code === "ArrowDown") { shiftGear(-1); return; }
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
        case "KeyO":
          setShowControls((shown) => !shown);
          break;
        case "KeyH":
          setShowHelp(false);
          setShowControls(false);
          setUiHidden((v) => {
            const next = !v;
            onNotify(
              next
                ? "HUD скрыт — остались только зеркала. Нажмите H, чтобы вернуть интерфейс."
                : "HUD показан"
            );
            return next;
          });
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (cameraMode === "cockpit") {
            sceneCtrlRef.current?.stepHeadDetent(code === "ArrowLeft" ? 1 : -1);
            setShifterGlance(false);
          }
          break;
        case "KeyG":
          toggleShifterGlance();
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
        case "Backspace":
          e.preventDefault();
          resetAttempt(worldRef.current, COLD_START);
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const code = logicalKey(bindingsRef.current, e.code);
      keysRef.current[code] = false;
    };

    const onBlur = () => {
      keysRef.current = {};
      releasePedals();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [resetAttempt, releasePedals, setTurnSignal, setGear, shiftGear, toggleEngine, onNotify, cameraMode, toggleShifterGlance]);

  // === [SEC:sim-pointer] Мышь на холсте, экранный руль, раздельные педали и импорт OSM ===
  // Управление мышью включается отдельно в панели «Управление»; по умолчанию выключено.
  // ПКМ вращает камеру, колесо масштабирует её.
  // 3D-селектор Shiftronic: отдельный pointer capture не конфликтует с мышиным рулём/орбитой.
  const shifterDragRef = useRef<{ id: number; startX: number; startY: number; moved: boolean; hit: ShifterHitId; target: ShifterTarget | null } | null>(null);
  const shifterHoverRef = useRef<ShifterHitId | null>(null);
  const readCanvasNorm = (canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  };
  const shifterTargetAt = (x: number, z: number): ShifterTarget => {
    const anchor = sceneCtrlRef.current?.getShifterLocalAnchor();
    const gateZ = anchor?.gateZ ?? 0;
    const dz = z - gateZ;
    const manual = x > (SHIFTER_LAYOUT.mainRailX + SHIFTER_LAYOUT.manualRailX) * 0.5;
    if (manual) {
      if (dz >= SHIFTER_LAYOUT.offMPlus - 0.02) return "M+";
      if (dz <= SHIFTER_LAYOUT.offMMinus + 0.02) return "M-";
      return "M";
    }
    if (dz >= (SHIFTER_LAYOUT.offP + SHIFTER_LAYOUT.offR) * 0.5) return "P";
    if (dz >= (SHIFTER_LAYOUT.offR + SHIFTER_LAYOUT.offN) * 0.5) return "R";
    if (dz >= (SHIFTER_LAYOUT.offN + SHIFTER_LAYOUT.offD) * 0.5) return "N";
    return "D";
  };

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

  // React может подключать wheel как passive listener; для preventDefault нужен native listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (e.cancelable) e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const hit = cameraMode === "cockpit" ? sceneCtrlRef.current?.pickCockpitShifter(x, y) : null;
      if (hit) stepCockpitShifter(e.deltaY < 0 ? 1 : -1);
      else sceneCtrlRef.current?.adjustZoom(e.deltaY);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [cameraMode, stepCockpitShifter]);

  const handleCanvasPointerEnter = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== "mouse" || !mouseSteerEnabled || mouseSteerMode !== "free") return;
    mouseSteerXRef.current = e.clientX;
    holdingSteerRef.current = true;
  };

  const handleCanvasPointerLeave = () => {
    if (shifterDragRef.current) return;
    shifterHoverRef.current = null;
    sceneCtrlRef.current?.setShifterInteraction(null, false, 0);
    if (pointerDragRef.current?.btn === 0) return;
    mouseSteerXRef.current = null;
    holdingSteerRef.current = false;
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 0 && cameraMode === "cockpit") {
      const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
      const ctrl = sceneCtrlRef.current;
      const hit = pos && ctrl ? ctrl.pickCockpitShifter(pos.x, pos.y) : null;
      if (hit && pos && ctrl) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        shifterDragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, hit, target: null };
        shifterHoverRef.current = hit;
        ctrl.setShifterInteraction(hit, true, 0);
        return;
      }
    }
    if (e.button === 1) {
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerDragRef.current = { id: e.pointerId, btn: e.button, lastX: e.clientX, lastY: e.clientY };
    if (e.button === 0 && e.pointerType === "mouse") {
      if (mouseSteerEnabled && mouseSteerMode === "hold") {
        holdingSteerRef.current = true;
        mouseSteerXRef.current = e.clientX;
      } else if (mouseSteerMode === "free") {
        // Не допускаем скачка руля при клике в свободном режиме.
        mouseSteerXRef.current = e.clientX;
      }
      if (mouseGasEnabled) {
        if (canvasGasHoldTimerRef.current !== null) window.clearTimeout(canvasGasHoldTimerRef.current);
        const owner = e.pointerId;
        canvasGasHoldTimerRef.current = window.setTimeout(() => {
          const drag = pointerDragRef.current;
          if (drag?.id === owner && drag.btn === 0 && pedalOwner.current.gas === null) {
            canvasGasOwnerRef.current = owner;
            pressPedal("gas", owner);
          }
          canvasGasHoldTimerRef.current = null;
        }, 400);
      }
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sDrag = shifterDragRef.current;
    const ctrl = sceneCtrlRef.current;
    if (sDrag && sDrag.id === e.pointerId && ctrl) {
      const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
      if (!pos) return;
      if (!sDrag.moved && Math.hypot(e.clientX - sDrag.startX, e.clientY - sDrag.startY) >= 5) sDrag.moved = true;
      if (sDrag.moved) {
        const local = ctrl.projectToShifterLocal(pos.x, pos.y);
        if (local) {
          sDrag.target = shifterTargetAt(local.x, local.z);
          ctrl.setShifterInteraction(sDrag.target === "M+" ? "M+" : sDrag.target === "M-" ? "M-" : sDrag.target, true,
            sDrag.target === "M+" ? 1 : sDrag.target === "M-" ? -1 : 0);
        }
      }
      return;
    }
    if (e.pointerType === "mouse" && mouseSteerEnabled) {
      const prevX = mouseSteerXRef.current;
      const activeDrag = pointerDragRef.current;
      const orbiting = activeDrag?.id === e.pointerId && activeDrag.btn === 2;
      const steeringActive = mouseSteerMode === "free" || (activeDrag?.id === e.pointerId && activeDrag.btn === 0);
      if (steeringActive && !orbiting) {
        // После включения опции указатель может уже находиться над canvas:
        // pointerenter тогда не повторится, поэтому используем movementX
        // для первого события, пока предыдущая координата ещё не инициализирована.
        const steerDx = prevX === null ? e.movementX : e.clientX - prevX;
        if (steerDx !== 0) {
          // Движение мыши вправо уменьшает swDeg (поворот вправо), без удержания ЛКМ.
          inputRef.current.steerWheelDeg = clamp(
            inputRef.current.steerWheelDeg - steerDx * 2.1,
            -STEER_WHEEL.maxDeg,
            STEER_WHEEL.maxDeg
          );
        }
      }
      if (steeringActive) mouseSteerXRef.current = e.clientX;
    }

    const drag = pointerDragRef.current;
    if (!drag || drag.id !== e.pointerId || drag.btn !== 2) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    sceneCtrlRef.current?.adjustOrbit(dx, dy);
  };

  const handleCanvasPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sDrag = shifterDragRef.current;
    if (sDrag && sDrag.id === e.pointerId) {
      shifterDragRef.current = null;
      const ctrl = sceneCtrlRef.current;
      if (sDrag.moved && sDrag.target) {
        engageCockpitShifter(sDrag.target, true);
      } else if (sDrag.hit === "lever") {
        if (isManualGear(inputRef.current.gear)) engageCockpitShifter("D");
        else if (inputRef.current.gear === "D") engageCockpitShifter("M");
        else stepCockpitShifter(1);
      } else if (sDrag.hit === "M" && isManualGear(inputRef.current.gear)) {
        engageCockpitShifter("D");
      } else {
        engageCockpitShifter(sDrag.hit as ShifterTarget);
      }
      const pos = readCanvasNorm(e.currentTarget, e.clientX, e.clientY);
      const hit = pos && ctrl && cameraMode === "cockpit" ? ctrl.pickCockpitShifter(pos.x, pos.y) : null;
      shifterHoverRef.current = hit;
      ctrl?.setShifterInteraction(hit, false, 0);
      return;
    }
    const drag = pointerDragRef.current;
    if (drag?.id !== e.pointerId) return;
    if (canvasGasHoldTimerRef.current !== null) {
      window.clearTimeout(canvasGasHoldTimerRef.current);
      canvasGasHoldTimerRef.current = null;
    }
    if (canvasGasOwnerRef.current === e.pointerId) {
      releasePedal("gas", e.pointerId);
      canvasGasOwnerRef.current = null;
    }
    pointerDragRef.current = null;
    const rect = e.currentTarget.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (mouseSteerMode === "hold" || !inside || !mouseSteerEnabled) mouseSteerXRef.current = null;
    holdingSteerRef.current = mouseSteerEnabled && mouseSteerMode === "free" && mouseSteerXRef.current !== null;
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
    if (quickStartUsed) return;
    rideStartedRef.current = true;
    setQuickStartUsed(true);
    setShowQuickStartPrompt(false);
    const inp = inputRef.current;
    const targetGear: Gear = defaultGearForWorld(worldRef.current);
    inp.engineOn = true;
    if (!engineSoundRef.current) engineSoundRef.current = new EngineSound();
    engineSoundRef.current.ensureStarted();
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
      `Холодный старт завершён: КПП переведена из P в ${targetGear}. Газ — W, ГАЗ или ЛКМ дольше 0,4 с; руль — движение мыши или A/D.`
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
      onCustomOsmChange(pack);
      onScenarioChange("city_osm");
      const signsPart = pack.signs.length > 0 ? `, знаков ${pack.signs.length}` : "";
      onNotify(
        `Загружен пакет: дорог ${pack.meta.roadsCount}, зданий ${pack.meta.buildingsCount}, светофоров ${pack.meta.signalsCount}${signsPart}`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Ошибка разбора файла карты (.osm / JSON / GeoJSON)");
    }
  };

  const s = hud.state;
  // Реальная улица под автомобилем — привязка HUD к маршруту OSM
  const street = useMemo(
    () => streetNameAt(s.x, s.z, world.roads, 18),
    [s.x, s.z, world.roads]
  );
  const kmh = Math.round(Math.abs(s.v) * 3.6);
  const gearDisplay = s.gear === "D" ? `D${s.autoSubGear}` : /^[1-6]$/.test(s.gear) ? `M${s.gear}` : s.gear;
  const { leftLit: leftBlink, rightLit: rightBlink } = getTurnSignalFlash(s.signal, s.time);
  const needsPrep = !s.engineOn || s.handbrake || !s.belt || s.gear === "P";

  return (
    <div className={immersive ? "fixed inset-0 z-[100] h-screen w-screen overflow-hidden bg-[#0d1720]" : "space-y-3"}>
      {/* [SEC:sim-toolbar] Верхняя панель выбора сценария, импорта OSM и завершения попытки */}
      {!immersive && <div className="flex flex-wrap items-center gap-2">
        <div className="segmented flex-wrap">
          {([
            ["bay_90", "1 · Бокс 90°"],
            ["parallel_v2", "2 · Параллельная (v2)"],
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

        <label className="flex items-center gap-2 rounded-lg border hairline px-2.5 py-1.5 text-[11px] text-[#9bafbc]">
          Автомобиль
          <select
            value={playerCarId}
            onChange={(e) => setPlayerCarId(e.target.value as PlayerCarId)}
            className="bg-[#111d28] text-[#e4edf3] rounded px-2 py-1 border border-white/10"
            aria-label="Выбор автомобиля"
          >
            {PLAYER_CARS.map((car) => <option key={car.id} value={car.id}>{car.name}</option>)}
          </select>
        </label>

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
              onCustomOsmChange(null);
              onNotify("Восстановлен встроенный экзаменационный маршрут МРЭО");
            }}
          >
            Эталонный маршрут
          </button>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <span className="hidden xl:inline-flex items-center gap-1.5 text-[11px] text-[#9bafbc] px-2 mono">
            Старт: ДВС заглушен · P
          </span>
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
            onClick={() => setShowHelp((v) => !v)}
            title="Клавиши и управление"
          >
            <Icon name="help" size={13} /> Клавиши
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => setShowControls((v) => !v)}
            title="Выворот колёс, скорость руления, педали и раскладка HUD"
          >
            <Icon name="sliders" size={13} /> Управление
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={onToggleImmersive}
            title="Полноэкранный режим без меню и панелей интерфейса"
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
      </div>}

      {/* Главная 3D-сцена с зеркалами, статусом экзаменатора и органами управления */}
      <div
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
        className={immersive ? "relative w-full h-full min-h-0 max-h-none rounded-none overflow-hidden border-0 bg-[#0d1720] select-none" : "relative w-full h-[560px] lg:h-[calc(100vh-152px)] min-h-[520px] max-h-[820px] rounded-2xl overflow-hidden border hairline bg-[#0d1720] select-none"}
      >
        {immersive && (
          <button
            type="button"
            onClick={onToggleImmersive}
            aria-label="Выйти из полноэкранного режима"
            title="Выйти из полноэкранного режима (Esc)"
            className="absolute right-4 top-4 z-[60] rounded-full border border-white/20 bg-black/55 px-3 py-2 text-xs font-bold text-white/80 backdrop-blur hover:bg-black/80 hover:text-white"
          >
            Выйти · Esc
          </button>
        )}
        <canvas
          ref={canvasRef}
          data-testid="sim-canvas"
          onPointerEnter={handleCanvasPointerEnter}
          onPointerLeave={handleCanvasPointerLeave}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerEnd}
          onPointerCancel={handleCanvasPointerEnd}
          onLostPointerCapture={handleCanvasPointerEnd}
          className="block w-full h-full cursor-grab active:cursor-grabbing touch-none"
        />

        {/* [SEC:sim-mirrors] Зеркала (320×96 и 320×160; в режиме H остаются видимыми) и экранный руль */}
        {!webglFallback && showRearMirror && (
          <FloatingPanel
            id="mirrorRear"
            title="Зеркало заднего вида"
            icon="eye"
            layout={layout.mirrorRear}
            defaults={(cw) => ({ x: Math.max(0, (cw - 270) / 2), y: 6, w: 270 })}
            minW={140}
            maxW={640}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={26}
          >
            <canvas ref={rearMirrorRef} role="img" aria-label="Отражение в зеркале заднего вида" width={320} height={96} className="block w-full h-auto" />
          </FloatingPanel>
        )}
        {!immersive && !webglFallback && showMirrors && (
          <FloatingPanel
            id="mirrorLeft"
            layout={layout.mirrorLeft}
            defaults={(_cw, ch) => ({ x: 12, y: Math.max(120, ch - 470), w: 170 })}
            minW={100}
            maxW={420}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={25}
          >
            <canvas ref={leftMirrorRef} role="img" aria-label="Отражение в левом зеркале" width={320} height={160} className="block w-full h-auto" />
          </FloatingPanel>
        )}
        {!webglFallback && showMirrors && (
          <FloatingPanel
            id="mirrorRight"
            layout={layout.mirrorRight}
            defaults={(cw, ch) => ({ x: Math.max(0, cw - 182), y: Math.max(120, ch - 470), w: 170 })}
            minW={100}
            maxW={420}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={25}
          >
            <canvas ref={rightMirrorRef} role="img" aria-label="Отражение в правом зеркале" width={320} height={160} className="block w-full h-auto" />
          </FloatingPanel>
        )}

        {/* Рулевое колесо: перетаскивается и масштабируется; поворот мышью/тачем и клавишами A/D */}
        {!immersive && !uiHidden && !webglFallback && (
          <FloatingPanel
            id="steeringWheel"
            layout={layout.steeringWheel}
            defaults={(cw, ch) => cw < 720
              ? {x: 8, y: ch - 162, w: 106}
              : {x: 12, y: Math.max(194, ch - 352), w: 150}}
            minW={96}
            maxW={320}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={24}
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
        {!immersive && !uiHidden && (
          <FloatingPanel
            id="scorePanel"
            layout={layout.scorePanel}
            defaults={() => ({ x: 12, y: 12, w: 232 })}
            minW={190}
            maxW={460}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={20}
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

        {/* Правый верхний блок: знак скорости + светофор + FPS (перенос долгим нажатием) */}
        {!uiHidden && (
          <FloatingPanel
            id="speedPanel"
            layout={layout.speedPanel}
            defaults={(cw) => ({ x: Math.max(0, cw - 236), y: 12, w: 232 })}
            minW={150}
            maxW={480}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={20}
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
                Draw {hud.perf.drawCalls} · Tri {(hud.perf.triangles / 1000).toFixed(1)}k · Geo {hud.perf.geometries}
              </div>
              <div className="text-[#6e8492]">
                Grid {hud.gridChecks}/{hud.totalObstacles} · Buildings {hud.perf.visibleBuildings}/{hud.perf.totalBuildings}
              </div>
            </div>
            </div>
          </FloatingPanel>
        )}

        {/* Строка статуса / задания экзаменатора (#status) */}
        {!uiHidden && (
          <FloatingPanel
            id="statusBar"
            layout={layout.statusBar}
            defaults={(cw) => ({ x: Math.max(0, (cw - 540) / 2), y: 148, w: 540 })}
            minW={300}
            maxW={820}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={20}
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
              {needsPrep && !s.finished && showQuickStartPrompt && !quickStartUsed && (
                <>
                  <span className="text-[11px] text-[#9fb2be]">Подготовка: ДВС, ремень, ручник и передача</span>
                  <button type="button" data-testid="quick-start-button" onClick={handleQuickStart} className="btn btn-primary btn-mini py-1 px-2.5">
                    Быстрый старт
                  </button>
                  <button type="button" data-testid="quick-start-dismiss" aria-label="Закрыть окно быстрого старта" title="Закрыть подсказку до следующего сброса" onClick={() => setShowQuickStartPrompt(false)} className="mono text-xs text-[#8fa2ae] hover:text-white px-1">
                    ✕
                  </button>
                </>
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

        {/* Всплывающая карточка зафиксированного нарушения */}
        {!immersive && !uiHidden && hud.latestViolation && (
          <div className="absolute left-1/2 -translate-x-1/2 top-[210px] z-30 rounded-xl bg-[#2a0f14]/95 border border-[#ff6b6b]/60 px-3.5 py-2 shadow-2xl max-w-[90%] fade-in">
            <div className="flex items-center gap-2 text-[11px] font-extrabold text-[#ff8585]">
              <Icon name="alert" size={14} />
              <span>+{hud.latestViolation.points} б. · {hud.latestViolation.title}</span>
            </div>
            <div className="text-[11px] text-[#f3d4d7] mt-0.5">{hud.latestViolation.detail}</div>
          </div>
        )}

        {/* Настройки управления: скорость руления клавишами A/D и сброс раскладки окон */}
        {!immersive && showControls && !uiHidden && (
          <div className="absolute right-3 top-16 z-40 w-[310px] max-h-[calc(100%-5rem)] overflow-y-auto scroll-thin rounded-2xl bg-[#0b131b]/96 backdrop-blur-md border hairline p-4 shadow-2xl fade-in">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-extrabold text-[#f5b942]">Управление</span>
              <button type="button" aria-label="Закрыть настройки управления" className="mono text-xs text-[#8fa2ae]" onClick={() => setShowControls(false)}>
                ✕
              </button>
            </div>
            <KeyBindingsEditor value={bindings} onChange={setBindings} />
            <HeadUnitPanel value={headUnit} onChange={setHeadUnit} />
            <div className="mb-4"><SteeringLimitControl value={wheelLimit} onChange={onWheelLockChange} /></div>
            <div className="mb-4 rounded-xl border hairline bg-[#101b25] p-3">
              <div className="mono text-[10px] text-[#7c909d] mb-2">УПРАВЛЕНИЕ МЫШЬЮ · ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО</div>
              <label className="flex items-center justify-between gap-3 text-[11px] text-[#d3e0e7] mb-2">
                <span>Руление мышью</span>
                <input data-testid="mouse-steer-toggle" type="checkbox" checked={mouseSteerEnabled} onChange={(e) => {
                  const enabled = e.target.checked; setMouseSteerEnabled(enabled);
                  mouseSteerXRef.current = null;
                  holdingSteerRef.current = false;
                }} className="accent-[#f5b942]" />
              </label>
              <label className="block text-[11px] text-[#d3e0e7] mb-2">
                <span className="block mb-1">Режим руления</span>
                <select data-testid="mouse-steer-mode" value={mouseSteerMode} onChange={(e) => {
                  const mode = e.target.value === "hold" ? "hold" : "free";
                  setMouseSteerMode(mode);
                  mouseSteerXRef.current = null;
                  holdingSteerRef.current = false;
                }} disabled={!mouseSteerEnabled} className="w-full rounded-lg border hairline bg-[#0b131b] px-2 py-1.5 text-[11px] text-[#d3e0e7] disabled:opacity-50">
                  <option value="free">Свободно, без ЛКМ</option>
                  <option value="hold">Только с зажатой ЛКМ</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 text-[11px] text-[#d3e0e7]">
                <span>Газ удержанием ЛКМ (&gt;0,4 с)</span>
                <input data-testid="mouse-gas-toggle" type="checkbox" checked={mouseGasEnabled} onChange={(e) => {
                  const enabled = e.target.checked; setMouseGasEnabled(enabled);
                  if (!enabled) {
                    if (canvasGasHoldTimerRef.current !== null) window.clearTimeout(canvasGasHoldTimerRef.current);
                    canvasGasHoldTimerRef.current = null;
                    if (canvasGasOwnerRef.current !== null) releasePedal("gas", canvasGasOwnerRef.current);
                    canvasGasOwnerRef.current = null;
                  }
                }} className="accent-[#f5b942]" />
              </label>
              <p className="text-[10px] text-[#7c909d] mt-2">В режиме с ЛКМ руль реагирует только на перетаскивание. Газ по долгому нажатию ЛКМ остаётся отдельной настройкой. Shift + газ — плавное увеличение тяги до x2.</p>
            </div>
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

            <div className="mt-3 pt-3 border-t hairline">
              <div className="mono text-[10px] text-[#7c909d] mb-1.5">ЗЕРКАЛА (НЕЗАВИСИМО)</div>
              <div className="flex flex-wrap gap-1.5">
                {([
                  ["Боковые (2:1)", showMirrors, () => setShowMirrors((v) => !v)],
                  ["Заднее (3.33:1)", showRearMirror, () => setShowRearMirror((v) => !v)],
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
            <div className="mt-3 pt-3 border-t hairline flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#9bafbc]">Раскладка HUD</span>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => {
                  setLayout({});
                  onNotify("Раскладка окон сброшена");
                }}
              >
                <Icon name="reset" size={12} /> Сбросить раскладку
              </button>
            </div>
            <p className="mt-2 text-[10px] text-[#93a6b0]">Для переноса педали потяните за полоску с точками над ней. Удержание кнопки нажимает педаль.</p>
          </div>
        )}

        {/* Справка по клавишам */}
        {!immersive && showHelp && (
          <div className="absolute right-3 top-16 z-30 w-[300px] rounded-2xl bg-[#0b131b]/96 backdrop-blur-md border hairline p-4 shadow-2xl fade-in">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs font-extrabold text-[#f5b942]">Управление (инварианты v8)</span>
              <button type="button" className="mono text-xs text-[#8fa2ae]" onClick={() => setShowHelp(false)}>
                ✕
              </button>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
              {[
                ["W / ↑", "Газ в выбранной передаче"],
                ["S / ↓", "Тормоз (в D не даёт реверс)"],
                ["A / D", "Руль влево (+X) / вправо (−X)"],
                ["Мышь", "Движение по сцене — руль; ЛКМ >0,4 с — газ"],
                ["ПКМ + колесо", "Вращение и зум камеры"],
                ["P / R / N / F", "Паркинг / Задний / Нейтраль / Drive"],
                ["I (в P/N)", "Запуск ДВС только из P или N"],
                ["Q / E / Z", "Поворотники лев. / прав. / аварийка"],
                ["I / Space / B", "Двигатель / Ручник / Ремень"],
                ["L · H", "Фары · Скрыть/показать HUD"],
                ["1–4 / C", "Вид: сзади, салон, сверху, орбита"],
                ["G", "Взгляд на селектор АКПП и обратно на дорогу"],
                ["← / →", "Взгляд на левое / правое зеркало в режиме салона"],
                ["3D-рычаг", "Перетащите селектор по кулисе P–R–N–D или в паз M+/M−"],
              ].map(([k, d]) => (
                <div key={k} className="contents">
                  <span className="mono text-[#f5b942] font-semibold">{k}</span>
                  <span className="text-[#b9c9d3]">{d}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Переключатели камеры, траектории, зеркал и качества (перенос долгим нажатием) */}
        {!uiHidden && (
          <FloatingPanel
            id="camToggles"
            layout={layout.camToggles}
            defaults={(cw, ch) => {
              const w = Math.min(660, cw - 16);
              return { x: (cw - w) / 2, y: ch - (cw < 720 ? 266 : cw < 960 ? 216 : 133), w };
            }}
            minW={250}
            maxW={680}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={21}
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
              <button
                type="button"
                onClick={toggleShifterGlance}
                className="px-2 py-1 rounded-lg text-[10px] font-bold border bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#f5b942]"
                title="Быстро посмотреть на селектор АКПП (G)"
              >
                {shifterGlance ? "На дорогу" : "КПП · G"}
              </button>
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
              onClick={() => setShowMirrors((v) => !v)}
              className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                showMirrors
                  ? "bg-[#52d6bd]/20 border-[#52d6bd]/50 text-[#52d6bd]"
                  : "bg-[#091017]/80 border-[rgba(148,176,194,.18)] text-[#8fa2ae]"
              }`}
              title="Боковые зеркала (2:1) — отключите для прироста FPS"
            >
              Боковые
            </button>
            <button
              type="button"
              onClick={() => setShowRearMirror((v) => !v)}
              className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                showRearMirror
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
        {!uiHidden && (
          <FloatingPanel
            id="cluster"
            layout={layout.cluster}
            defaults={(cw, ch) => {
              const w = Math.min(620, cw - 16);
              return { x: (cw - w) / 2, y: ch - (cw < 720 ? 185 : cw < 960 ? 160 : 82), w };
            }}
            minW={330}
            maxW={880}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={22}
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
                    className={`h-full transition-all ${s.rpm > 5200 ? "bg-[#ff6b6b]" : "bg-[#52d6bd]"}`}
                    style={{ width: `${Math.min(100, (s.rpm / 6500) * 100)}%` }}
                  />
                </div>
                <div className="mono text-[9px] text-[#6e8492] mt-0.5">
                  {s.engineOn ? `${Math.round(s.rpm)} об` : "ЗАГЛУШЕН"}
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

              {/* Селектор АКПП: P (Parking) / R / N / D */}
              <div className="flex items-center gap-1 border-l hairline pl-2.5">
                {(["P", "R", "N", "D"] as const).map((g) => {
                  const active = s.gear === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setGear(g)}
                      title={
                        g === "P"
                          ? "P (Parking) — стоянка, тяги нет. Включается только на остановке"
                          : g === "R"
                            ? "Задний ход (R)"
                            : g === "N"
                              ? "Нейтраль (N)"
                              : "Drive (F)"
                      }
                      className={`mono h-8 min-w-[30px] px-2 rounded-lg text-xs font-bold border transition ${
                        active
                          ? g === "P"
                            ? "bg-[#94a3b8] text-[#081512] border-[#94a3b8]"
                            : g === "R"
                              ? "bg-[#f5b942] text-[#17130a] border-[#f5b942]"
                              : "bg-[#52d6bd] text-[#081512] border-[#52d6bd]"
                          : "border-[rgba(148,176,194,.2)] text-[#8fa2ae] hover:text-white"
                      }`}
                    >
                      {active && g === "D" ? gearDisplay : g}
                    </button>
                  );
                })}
                <button type="button" onClick={() => shiftGear(-1)} className="mono h-8 min-w-[28px] px-2 rounded-lg text-xs font-bold border hairline" title="Понизить передачу (Shift + ↓)">−</button>
                <button type="button" onClick={() => shiftGear(1)} className="mono h-8 min-w-[28px] px-2 rounded-lg text-xs font-bold border hairline" title="Повысить передачу (Shift + ↑)">+</button>
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

        {/* Две независимые панели. Перенос — только за grip; на самой педали нет long press. */}
        {!uiHidden && (["brake", "gas"] as const).map((which) => {
          const gas = which === "gas";
          const id = gas ? "pedalGas" : "pedalBrake";
          const width = gas ? 76 : 84;
          return (
            <FloatingPanel key={id} id={id} activation="grip" resizable={false}
              gripLabel={gas ? "Переместить педаль газа" : "Переместить педаль тормоза"}
              layout={layout[id]} defaults={(cw, ch) => ({
                x: Math.max(0, cw - 12 - width - (gas ? 0 : 86)), y: Math.max(0, ch - 98), w: width,
              })}
              minW={width} maxW={width} onChange={handleLayoutChange} containerRef={containerRef} zIndex={27}>
              <button type="button" {...bindPedal(which)} aria-label={gas ? "Газ" : "Тормоз"}
                aria-pressed={pedalVisual[which]} title={gas ? "Газ: удерживайте кнопку или W" : "Тормоз: удерживайте кнопку или S"}
                className={`pedal-face ${gas ? "pedal-gas" : "pedal-brake"}`}>
                <span className="pedal-tread" aria-hidden="true" />
                <span className="pedal-caption">{gas ? "ГАЗ" : "ТОРМОЗ"}<kbd>{gas ? "W" : "S"}</kbd></span>
              </button>
            </FloatingPanel>
          );
        })}

        {/* В режиме H на экране остаются только зеркала. Вернуть HUD — клавиша H. */}
      </div>

      {/* Компактная нижняя строка метаданных: габариты, версия правил, обязательная атрибуция ODbL */}
      {!immersive && <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#7c909d] px-1">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="neutral">{getPlayerCar(s.carId).shortName} · {getPlayerCar(s.carId).length}×{getPlayerCar(s.carId).width} м · Выворот {wheelLimit.toLocaleString("ru-RU")}°</Chip>
          <Chip tone={ruleSet.status === "instructor_signed" ? "mint" : "amber"}>
            Правила: {ruleSet.version} ({ruleSet.status === "instructor_signed" ? "подписано" : "демо"})
          </Chip>
          <span className="font-bold text-[#b9c9d3]">{world.title}</span>
          <span>{world.subtitle}</span>
          {street && (
            <span className="mono text-[#52d6bd] flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#52d6bd]" />
              ул.: {street.name}
              {street.limitKmh ? ` · ${street.limitKmh} км/ч` : ""}
            </span>
          )}
        </div>
        <div className="mono text-[10px] text-[#8fa2ae]">
          {world.mapMeta
            ? `Данные карты ${world.mapMeta.attribution} (${world.mapMeta.license}) · офлайн`
            : "Учебный тренажёр · не заменяет экзамен в ГИБДД"}
        </div>
      </div>}
    </div>
  );
}
