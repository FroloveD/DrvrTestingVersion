import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserGamepadPoller,
  DEFAULT_GAMEPAD_CONFIG,
  detectWheelProfile,
  WHEEL_PROFILE_LABELS,
  type GamepadConfig,
  type WheelProfileId,
} from "../input/gamepad";
import { parseOsmOrGeoJson, type NormalizedOsmPack } from "../maps/osmLoader";
import { trafficCorners, trafficPoseAt } from "../sim/traffic";
import { SceneController, type PerfMetrics } from "../render/sceneController";
import { buildScenarioWorld } from "../scenarios/catalog";
import type { CustomScenarioDef } from "../scenarios/custom";
import { evaluateAttempt, type EvaluationResult, type RuleSet } from "../scoring/rules";
import { AttemptRecorder, type RecordedAttempt } from "../sim/recorder";
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
  CAR,
  clamp,
  FIXED_DT,
  getCarCorners,
  getTrafficLightPhase,
  getTurnSignalFlash,
  STEER_WHEEL,
} from "../sim/vehicle";
import { Chip, Icon } from "./Icons";
import { FloatingPanel, loadLayout, saveLayout, type LayoutMap, type PanelLayout } from "./FloatingPanel";

type Props = {
  scenarioId: ScenarioId;
  onScenarioChange: (id: ScenarioId) => void;
  calibration: CalibrationConfig;
  ruleSet: RuleSet;
  customOsm: NormalizedOsmPack | null;
  onCustomOsmChange: (pack: NormalizedOsmPack | null) => void;
  customDef: CustomScenarioDef;
  onAttemptSaved: (attempt: RecordedAttempt, openDebrief: boolean) => void;
  onNotify: (msg: string) => void;
};

const CONTROLS_KEY = "cdt.controls.v1";
const DEFAULT_STEER_KEY_RATE = 340;
/** Старт и сброс попытки всегда «холодные»: ДВС заглушен, КПП P. */
const COLD_START = false;

function loadControls(): { steerKeyRate: number; gamepad: GamepadConfig } {
  try {
    const raw = localStorage.getItem(CONTROLS_KEY);
    const parsed = raw ? (JSON.parse(raw) as { steerKeyRate?: number; gamepad?: Partial<GamepadConfig> }) : {};
    const rate = Number(parsed.steerKeyRate);
    const gp: GamepadConfig = {
      ...DEFAULT_GAMEPAD_CONFIG,
      ...(parsed.gamepad ?? {}),
      deadzone: clamp(Number(parsed.gamepad?.deadzone ?? DEFAULT_GAMEPAD_CONFIG.deadzone), 0.01, 0.3),
    };
    return {
      steerKeyRate: Number.isFinite(rate) ? clamp(rate, 60, 900) : DEFAULT_STEER_KEY_RATE,
      gamepad: gp,
    };
  } catch {
    return { steerKeyRate: DEFAULT_STEER_KEY_RATE, gamepad: DEFAULT_GAMEPAD_CONFIG };
  }
}

function saveControls(c: { steerKeyRate: number; gamepad: GamepadConfig }): void {
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

  // Движущиеся машины трафика
  for (const tv of world.traffic) {
    const pose = trafficPoseAt(tv, s.time);
    const tcorners = trafficCorners(pose, tv);
    ctx.fillStyle = "#818cf8";
    ctx.beginPath();
    tcorners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.z) : ctx.lineTo(c.x, c.z)));
    ctx.closePath();
    ctx.fill();
  }

  // Автомобиль игрока
  const corners = getCarCorners(s.x, s.z, s.h);
  ctx.fillStyle = "#f5b942";
  ctx.beginPath();
  corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.z) : ctx.lineTo(c.x, c.z)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function SimulatorView({
  scenarioId,
  onScenarioChange,
  calibration,
  ruleSet,
  customOsm,
  onCustomOsmChange,
  customDef,
  onAttemptSaved,
  onNotify,
}: Props) {
  const world = useMemo(
    () => buildScenarioWorld(scenarioId, calibration, customOsm, customDef),
    [scenarioId, calibration, customOsm, customDef]
  );

  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  const [quality, setQuality] = useState<QualityPreset>("medium");
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [showMirrors, setShowMirrors] = useState(true);
  const [uiHidden, setUiHidden] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [webglFallback, setWebglFallback] = useState(false);
  const [pedalVisual, setPedalVisual] = useState<{ gas: boolean; brake: boolean }>({ gas: false, brake: false });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rearMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const leftMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const rightMirrorRef = useRef<HTMLCanvasElement | null>(null);
  const wheelSvgRef = useRef<SVGSVGElement | null>(null);
  const wheelGroupRef = useRef<SVGGElement | null>(null);

  // Настраиваемая скорость руления клавишами A/D, профиль USB-руля/геймпада и раскладка плавающих окон
  const [steerKeyRate, setSteerKeyRate] = useState<number>(() => loadControls().steerKeyRate);
  const [gamepadCfg, setGamepadCfg] = useState<GamepadConfig>(() => loadControls().gamepad);
  const [gamepadStatus, setGamepadStatus] = useState<{ connected: boolean; name: string }>({
    connected: false,
    name: "",
  });
  const steerRateRef = useRef<number>(steerKeyRate);
  const gamepadCfgRef = useRef<GamepadConfig>(gamepadCfg);
  const gamepadPollerRef = useRef<BrowserGamepadPoller>(new BrowserGamepadPoller());
  const [showControls, setShowControls] = useState(false);
  const [layout, setLayout] = useState<LayoutMap>(loadLayout);

  useEffect(() => {
    steerRateRef.current = steerKeyRate;
    gamepadCfgRef.current = gamepadCfg;
    saveControls({ steerKeyRate, gamepad: gamepadCfg });
  }, [steerKeyRate, gamepadCfg]);

  // Автоопределение профиля при подключении USB-руля / геймпада
  useEffect(() => {
    const onConnect = (e: GamepadEvent) => {
      const detected = detectWheelProfile(e.gamepad.id);
      setGamepadCfg((prev) => ({ ...prev, profile: detected }));
      onNotify(`Подключено устройство: ${e.gamepad.id.slice(0, 36)} (${WHEEL_PROFILE_LABELS[detected].name})`);
    };
    const onDisconnect = () => {
      setGamepadStatus({ connected: false, name: "" });
      onNotify("USB-руль / геймпад отключён — активно управление с клавиатуры");
    };
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
    };
  }, [onNotify]);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  const handleLayoutChange = useCallback((id: string, next: PanelLayout) => {
    setLayout((prev) => ({ ...prev, [id]: next }));
  }, []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Мутабельные рефы симуляционного цикла (без лишних ререндеров на 60 Гц)
  const sceneCtrlRef = useRef<SceneController | null>(null);
  const worldRef = useRef<WorldData>(world);
  const gridRef = useRef<SpatialGrid>(new SpatialGrid(world.obstacles, 10));
  const calRef = useRef<CalibrationConfig>(calibration);
  const ruleRef = useRef<RuleSet>(ruleSet);
  // Всегда холодный старт: ДВС заглушен, КПП в P (Parking), ручник затянут.
  const stateRef = useRef<SimState>(createInitialState(world, false));
  const inputRef = useRef<InputState>(createInitialInput());
  const recorderRef = useRef<AttemptRecorder>(new AttemptRecorder(stateRef.current, false));
  const autoSavedRef = useRef(false);

  const keysRef = useRef<Record<string, boolean>>({});
  const touchPedalRef = useRef<{ gas: boolean; brake: boolean }>({ gas: false, brake: false });
  const holdingSteerRef = useRef(false);
  const latestViolationRef = useRef<HudSnapshot["latestViolation"]>(null);
  const optsRef = useRef({
    cameraMode,
    quality,
    showTrajectory,
    showMirrors,
    showLearnerSign: calibration.showLearnerSign,
    drawRadius: 145,
  });

  useEffect(() => {
    optsRef.current = {
      cameraMode,
      quality,
      showTrajectory,
      showMirrors,
      showLearnerSign: calibration.showLearnerSign,
      drawRadius: quality === "low" ? 95 : quality === "medium" ? 145 : 220,
    };
    sceneCtrlRef.current?.applyQuality(quality);
  }, [cameraMode, quality, showTrajectory, showMirrors, calibration.showLearnerSign]);

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

  const setTurnSignal = useCallback((signal: InputState["signal"]) => {
    inputRef.current.signal = signal;
    // Reflect a signal button/key press immediately instead of waiting for the next HUD tick.
    setHud((current) => ({ ...current, state: { ...current.state, signal } }));
  }, []);

  /** Выбор режима АКПП с блокировками: P — только на остановке, выход из P — после запуска ДВС. */
  const setGear = useCallback(
    (gear: Gear) => {
      const inp = inputRef.current;
      if (gear === "P" && Math.abs(stateRef.current.v) > 0.35) {
        onNotify("Парковку P можно включить только после полной остановки (тормоз S)");
        return;
      }
      if (inp.gear === "P" && gear !== "P" && !inp.engineOn) {
        onNotify("Сначала запустите двигатель (I), затем выберите R или D");
        return;
      }
      inp.gear = gear;
      setHud((current) => ({ ...current, state: { ...current.state, gear } }));
    },
    [onNotify]
  );

  /** Запуск ДВС разрешён только в P или N; заглушить можно в любом режиме. */
  const toggleEngine = useCallback(() => {
    const inp = inputRef.current;
    if (!inp.engineOn && inp.gear !== "P" && inp.gear !== "N") {
      onNotify("Запуск двигателя возможен только в P (Parking) или N");
      return;
    }
    inp.engineOn = !inp.engineOn;
    setHud((current) => ({
      ...current,
      state: { ...current.state, engineOn: inp.engineOn },
    }));
  }, [onNotify]);

  const resetAttempt = useCallback(
    (targetWorld: WorldData, useReady: boolean) => {
      const defGear: Gear = defaultGearForWorld(targetWorld);
      const initState = createInitialState(targetWorld, useReady);
      stateRef.current = initState;
      inputRef.current = useReady ? createReadyInput(defGear) : createInitialInput();
      gridRef.current = new SpatialGrid(targetWorld.obstacles, 10);
      recorderRef.current = new AttemptRecorder(initState, useReady);
      latestViolationRef.current = null;
      autoSavedRef.current = false;
      keysRef.current = {};
      touchPedalRef.current = { gas: false, brake: false };
      setPedalVisual({ gas: false, brake: false });
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
    []
  );

  // Перезагрузка мира при смене сценария, калибровки или OSM-файла
  useEffect(() => {
    worldRef.current = world;
    sceneCtrlRef.current?.loadWorld(world);
    resetAttempt(world, COLD_START);
  }, [world, resetAttempt]);

  // Инициализация Three.js и главного цикла с фиксированным шагом 1/60 с
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = containerRef.current;
    if (!canvas || !box) return;

    let ctrl: SceneController | null = null;
    try {
      ctrl = new SceneController(canvas);
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
      const frameDelta = Math.min((nowMs - lastMs) / 1000, 0.1);
      lastMs = nowMs;
      accumulator += frameDelta;

      const keys = keysRef.current;
      const inp = inputRef.current;
      const newEventsBatch: SimEvent[] = [];

      // Опрос адаптера USB-руля / педалей / геймпада → общий контракт InputState
      const gp = gamepadPollerRef.current.poll(gamepadCfgRef.current);
      if (gp.gearCommand) inp.gear = gp.gearCommand;
      if (gp.toggleHandbrake) inp.handbrake = !inp.handbrake;
      if (gp.toggleBelt) inp.belt = !inp.belt;
      if (gp.toggleLights) inp.lights = !inp.lights;
      if (gp.toggleEngine) {
        if (!inp.engineOn && inp.gear !== "P" && inp.gear !== "N") {
          onNotify("Для запуска ДВС переведите селектор в P (Parking) или N");
        } else {
          inp.engineOn = !inp.engineOn;
        }
      }
      if (gp.signalToggle) {
        inp.signal = inp.signal === gp.signalToggle ? null : gp.signalToggle;
      }

      // Фиксированный шаг 1/60 с (детерминированное ядро)
      while (accumulator >= FIXED_DT) {
        const gasPressed = Boolean(keys.KeyW || keys.ArrowUp || touchPedalRef.current.gas);
        const brakePressed = Boolean(keys.KeyS || keys.ArrowDown || touchPedalRef.current.brake);
        inp.throttle = Math.max(gasPressed ? 1 : 0, gp.throttle);
        inp.brake = Math.max(brakePressed ? 1 : 0, gp.brake);

        // Руление: USB-руль/стик либо клавиатура A (+swDeg) / D (-swDeg)
        const steerL = Boolean(keys.KeyA || keys.ArrowLeft);
        const steerR = Boolean(keys.KeyD || keys.ArrowRight);
        if (gp.steeringActive) {
          inp.steerWheelDeg = gp.steerWheelDeg;
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
        recorderRef.current.recordTick(inp, out.state, out.newEvents);
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
        onAttemptSaved(snap, false);
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
        setGamepadStatus((prev) =>
          prev.connected === gp.connected && prev.name === gp.deviceId
            ? prev
            : { connected: gp.connected, name: gp.deviceId }
        );
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
  }, [onAttemptSaved]);

  // Обработчики клавиатуры (все клавиши по DEV_PROMPTS + защита от залипания при blur)
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const code = e.code;
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(code)) {
        e.preventDefault();
      }
      keysRef.current[code] = true;
      if (e.repeat) return;

      const inp = inputRef.current;
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
      keysRef.current[e.code] = false;
    };

    const onBlur = () => {
      keysRef.current = {};
      touchPedalRef.current = { gas: false, brake: false };
      holdingSteerRef.current = false;
      setPedalVisual({ gas: false, brake: false });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [resetAttempt, setTurnSignal, setGear, toggleEngine, onNotify]);

  // Управление мышью на 3D-холсте (инварианты №4, №5, №6: ЛКМ — руль, ПКМ — камера, колесо — зум)
  const pointerDragRef = useRef<{ id: number; btn: number; lastX: number; lastY: number } | null>(null);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1) {
      e.preventDefault(); // средняя кнопка не включает педали и не запускает автоскролл
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerDragRef.current = { id: e.pointerId, btn: e.button, lastX: e.clientX, lastY: e.clientY };
    if (e.button === 0) holdingSteerRef.current = true;
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
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
    } else if (drag.btn === 2) {
      sceneCtrlRef.current?.adjustOrbit(dx, dy);
    }
  };

  const handleCanvasPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerDragRef.current?.id === e.pointerId) {
      if (pointerDragRef.current.btn === 0) holdingSteerRef.current = false;
      pointerDragRef.current = null;
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

  // Педали с setPointerCapture и обработкой pointercancel / lostpointercapture (защита от залипания)
  const bindPedal = (which: "gas" | "brake") => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      touchPedalRef.current[which] = true;
      setPedalVisual({ ...touchPedalRef.current });
    },
    onPointerUp: () => {
      touchPedalRef.current[which] = false;
      setPedalVisual({ ...touchPedalRef.current });
    },
    onPointerCancel: () => {
      touchPedalRef.current[which] = false;
      setPedalVisual({ ...touchPedalRef.current });
    },
    onLostPointerCapture: () => {
      touchPedalRef.current[which] = false;
      setPedalVisual({ ...touchPedalRef.current });
    },
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
      const parsed = JSON.parse(text);
      const pack = parseOsmOrGeoJson(parsed, `OSM: ${file.name.replace(/\.(geo)?json$/i, "")}`);
      if (pack.roads.length === 0) {
        onNotify("В файле не найдено дорог с тегом highway");
        return;
      }
      onCustomOsmChange(pack);
      onScenarioChange("city_osm");
      onNotify(
        `Загружен пакет: дорог ${pack.meta.roadsCount}, зданий ${pack.meta.buildingsCount}, светофоров ${pack.meta.signalsCount}`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Ошибка разбора OSM/GeoJSON-файла");
    }
  };

  const s = hud.state;
  const kmh = Math.round(Math.abs(s.v) * 3.6);
  const gearDisplay = s.gear === "D" ? `D${s.autoSubGear}` : s.gear;
  const { leftLit: leftBlink, rightLit: rightBlink } = getTurnSignalFlash(s.signal, s.time);
  const needsPrep = !s.engineOn || s.handbrake || !s.belt || s.gear === "P";

  return (
    <div className="space-y-3">
      {/* Верхняя панель выбора сценария, импорта OSM и завершения попытки */}
      <div className="flex flex-wrap items-center gap-2">
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

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.geojson,application/json"
          className="hidden"
          onChange={handleOsmFile}
        />
        <button
          type="button"
          className="btn btn-mini"
          onClick={() => fileInputRef.current?.click()}
          title="Импорт локального Overpass OSM JSON или GeoJSON (до 30 МБ, офлайн)"
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
            title="Скорость руления клавишами и раскладка окон"
          >
            <Icon name="sliders" size={13} /> Управление
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

      {/* Главная 3D-сцена с зеркалами, статусом экзаменатора и органами управления */}
      <div
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
        className="relative w-full h-[560px] lg:h-[calc(100vh-152px)] min-h-[520px] max-h-[820px] rounded-2xl overflow-hidden border hairline bg-[#0d1720] select-none"
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerEnd}
          onPointerCancel={handleCanvasPointerEnd}
          onWheel={(e) => {
            e.preventDefault();
            sceneCtrlRef.current?.adjustZoom(e.deltaY);
          }}
          className="block w-full h-full cursor-grab active:cursor-grabbing touch-none"
        />

        {/* Плавающие окна: перетаскивание за заголовок, размер — за правый нижний угол.
            В режиме H (скрытый HUD) зеркала остаются на экране намеренно. */}
        {!webglFallback && (showMirrors || uiHidden) && (
          <FloatingPanel
            id="mirrorRear"
            title="Зеркало заднего вида"
            icon="eye"
            layout={layout.mirrorRear}
            defaults={(cw) => ({ x: Math.max(0, (cw - 290) / 2), y: 8, w: 290 })}
            minW={140}
            maxW={640}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={26}
          >
            <canvas ref={rearMirrorRef} width={320} height={120} className="block w-full h-auto" />
          </FloatingPanel>
        )}
        {!webglFallback && (showMirrors || uiHidden) && (
          <FloatingPanel
            id="mirrorLeft"
            title="Левое зеркало (+X)"
            icon="eye"
            layout={layout.mirrorLeft}
            defaults={(_cw, ch) => ({ x: 12, y: Math.max(120, ch - 470), w: 170 })}
            minW={100}
            maxW={420}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={25}
          >
            <canvas ref={leftMirrorRef} width={320} height={120} className="block w-full h-auto" />
          </FloatingPanel>
        )}
        {!webglFallback && (showMirrors || uiHidden) && (
          <FloatingPanel
            id="mirrorRight"
            title="Правое зеркало (−X)"
            icon="eye"
            layout={layout.mirrorRight}
            defaults={(cw, ch) => ({ x: Math.max(0, cw - 182), y: Math.max(120, ch - 470), w: 170 })}
            minW={100}
            maxW={420}
            onChange={handleLayoutChange}
            containerRef={containerRef}
            zIndex={25}
          >
            <canvas ref={rightMirrorRef} width={320} height={120} className="block w-full h-auto" />
          </FloatingPanel>
        )}

        {/* Рулевое колесо: перетаскивается и масштабируется; поворот мышью/тачем и клавишами A/D */}
        {!uiHidden && !webglFallback && (
          <FloatingPanel
            id="steeringWheel"
            title="Руль"
            icon="target"
            layout={layout.steeringWheel}
            defaults={(_cw, ch) => ({ x: 12, y: Math.max(120, ch - 250), w: 150 })}
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
              <div className="mono text-[8px] text-[#6e8492]">
                Л {((s.steerLeft * 180) / Math.PI).toFixed(0)}° · П {((s.steerRight * 180) / Math.PI).toFixed(0)}°
              </div>
            </div>
          </FloatingPanel>
        )}

        {/* Левый верхний блок: штрафные баллы rules.json vs v8 */}
        {!uiHidden && (
          <div className="absolute left-3 top-3 z-20 rounded-xl bg-[#091017]/84 backdrop-blur-md border hairline px-3 py-2 max-w-[235px]">
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
        )}

        {/* Правый верхний блок: знак скорости + ближайший светофор + FPS/p95 */}
        {!uiHidden && (
          <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
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
        )}

        {/* Строка статуса / задания экзаменатора (#status) */}
        {!uiHidden && (
          <div className="absolute left-1/2 -translate-x-1/2 top-[118px] z-20 max-w-[92%] sm:max-w-[56%]">
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
        )}

        {/* Всплывающая карточка зафиксированного нарушения */}
        {!uiHidden && hud.latestViolation && (
          <div className="absolute left-1/2 -translate-x-1/2 top-[178px] z-30 rounded-xl bg-[#2a0f14]/95 border border-[#ff6b6b]/60 px-3.5 py-2 shadow-2xl max-w-[90%] fade-in">
            <div className="flex items-center gap-2 text-[11px] font-extrabold text-[#ff8585]">
              <Icon name="alert" size={14} />
              <span>+{hud.latestViolation.points} б. · {hud.latestViolation.title}</span>
            </div>
            <div className="text-[11px] text-[#f3d4d7] mt-0.5">{hud.latestViolation.detail}</div>
          </div>
        )}

        {/* Настройки управления: скорость руления клавишами A/D и сброс раскладки окон */}
        {showControls && !uiHidden && (
          <div className="absolute right-3 top-16 z-40 w-[300px] rounded-2xl bg-[#0b131b]/96 backdrop-blur-md border hairline p-4 shadow-2xl fade-in">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-extrabold text-[#f5b942]">Управление рулём</span>
              <button type="button" className="mono text-xs text-[#8fa2ae]" onClick={() => setShowControls(false)}>
                ✕
              </button>
            </div>
            <label className="block text-[11px] text-[#d3e0e7] mb-1.5">
              Скорость руления клавишами A / D:{" "}
              <b className="mono text-[#f5b942]">{steerKeyRate}°/с</b>
            </label>
            <input
              type="range"
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

            {/* Профиль и калибровка USB-руля / педалей / геймпада */}
            <div className="mt-3 pt-3 border-t hairline space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-bold text-[#e9f1f5]">USB-руль и педали</span>
                <label className="inline-flex items-center gap-1.5 text-[10px] text-[#9bafbc] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={gamepadCfg.enabled}
                    onChange={(e) => setGamepadCfg({ ...gamepadCfg, enabled: e.target.checked })}
                  />
                  Вкл
                </label>
              </div>
              <select
                value={gamepadCfg.profile}
                disabled={!gamepadCfg.enabled}
                onChange={(e) =>
                  setGamepadCfg({ ...gamepadCfg, profile: e.target.value as WheelProfileId })
                }
                className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-[11px] text-white disabled:opacity-50"
              >
                {(Object.keys(WHEEL_PROFILE_LABELS) as WheelProfileId[]).map((pid) => (
                  <option key={pid} value={pid}>
                    {WHEEL_PROFILE_LABELS[pid].name}
                  </option>
                ))}
              </select>
              <div className="flex items-center justify-between text-[10px] text-[#b9c9d3]">
                <span>Мёртвая зона оси руля</span>
                <span className="mono text-[#52d6bd]">{Math.round(gamepadCfg.deadzone * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.01}
                max={0.25}
                step={0.01}
                disabled={!gamepadCfg.enabled}
                value={gamepadCfg.deadzone}
                onChange={(e) => setGamepadCfg({ ...gamepadCfg, deadzone: Number(e.target.value) })}
                className="w-full"
              />
              {gamepadCfg.profile !== "standard" && (
                <label className="inline-flex items-center gap-1.5 text-[10px] text-[#9bafbc] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={gamepadCfg.invertPedals}
                    onChange={(e) => setGamepadCfg({ ...gamepadCfg, invertPedals: e.target.checked })}
                  />
                  Инвертировать оси педалей (+1 в покое → −1 нажата)
                </label>
              )}
              <div className="mono text-[9.5px] leading-snug text-[#7c909d]">
                {gamepadStatus.connected ? (
                  <span className="text-[#52d6bd]">● Подключено: {gamepadStatus.name}</span>
                ) : (
                  <span>○ Устройство не обнаружено — подключите USB-руль и нажмите любую кнопку</span>
                )}
              </div>
            </div>

            <div className="mt-3 pt-3 border-t hairline flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#9bafbc]">Окна и зеркала</span>
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
          </div>
        )}

        {/* Справка по клавишам */}
        {showHelp && (
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
                ["ЛКМ / SVG", "Плавное вращение руля ±540°"],
                ["ПКМ + колесо", "Вращение и зум камеры"],
                ["P / R / N / F", "Паркинг / Задний / Нейтраль / Drive"],
                ["I (в P/N)", "Запуск ДВС только из P или N"],
                ["Q / E / Z", "Поворотники лев. / прав. / аварийка"],
                ["I / Space / B", "Двигатель / Ручник / Ремень"],
                ["L · H", "Фары · Скрыть/показать HUD"],
                ["1–4 / C", "Вид: сзади, салон, сверху, орбита"],
              ].map(([k, d]) => (
                <div key={k} className="contents">
                  <span className="mono text-[#f5b942] font-semibold">{k}</span>
                  <span className="text-[#b9c9d3]">{d}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Переключатели камеры, траектории, зеркал и качества (слева над панелью) */}
        {!uiHidden && (
          <div className="absolute left-3 bottom-[122px] sm:bottom-[104px] z-20 flex flex-wrap items-center gap-1.5">
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
              title="Отключите зеркала для прироста FPS на слабом GPU"
            >
              Зеркала
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
        )}

        {/* Нижняя приборная панель: экранный руль ±540°, приборы, КПП, тумблеры, педали */}
        {!uiHidden && (
          <div className="absolute inset-x-3 bottom-3 z-20 flex flex-wrap items-end justify-between gap-2 pointer-events-none">
            {/* Центральный блок приборов, КПП и тумблеров */}
            <div className="pointer-events-auto rounded-2xl bg-[#091017]/88 backdrop-blur-md border hairline px-3 py-2 flex flex-wrap items-center gap-3">
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

            {/* Экранные/тач-педали ТОРМОЗ (S) и ГАЗ (W) с захватом указателя */}
            <div className="pointer-events-auto flex items-center gap-2">
              <button
                type="button"
                {...bindPedal("brake")}
                className={`h-16 w-16 rounded-2xl border font-extrabold text-[11px] touch-none transition ${
                  pedalVisual.brake
                    ? "bg-[#ff6b6b] text-[#1f0909] border-[#ff6b6b] scale-95"
                    : "bg-[#091017]/86 backdrop-blur-md border-[#ff6b6b]/40 text-[#ff9494]"
                }`}
              >
                СТОП
                <span className="block mono text-[9px] opacity-75">S</span>
              </button>
              <button
                type="button"
                {...bindPedal("gas")}
                className={`h-16 w-16 rounded-2xl border font-extrabold text-[11px] touch-none transition ${
                  pedalVisual.gas
                    ? "bg-[#52d6bd] text-[#071915] border-[#52d6bd] scale-95"
                    : "bg-[#091017]/86 backdrop-blur-md border-[#52d6bd]/45 text-[#52d6bd]"
                }`}
              >
                ГАЗ
                <span className="block mono text-[9px] opacity-75">W</span>
              </button>
            </div>
          </div>
        )}

        {/* В режиме H на экране остаются только зеркала. Вернуть HUD — клавиша H. */}
      </div>

      {/* Компактная нижняя строка метаданных: габариты, версия правил, обязательная атрибуция ODbL */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#7c909d] px-1">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="neutral">{CAR.model} · {CAR.length}×{CAR.width} м · Аккерман {CAR.maxInnerDeg}°</Chip>
          <Chip tone={ruleSet.status === "instructor_signed" ? "mint" : "amber"}>
            Правила: {ruleSet.version} ({ruleSet.status === "instructor_signed" ? "подписано" : "демо"})
          </Chip>
          <span>{world.subtitle}</span>
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
