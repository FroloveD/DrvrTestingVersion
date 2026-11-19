/**
 * @module input/gamepad
 * @layer input-pure
 * @role Чистый адаптер USB-руля, педалей и геймпада: пошаговая калибровка, мёртвые зоны и защита `AxisArming`.
 * @invariants #1–#3 (руль влево = `+swDeg`, раздельные газ/тормоз), выключен по умолчанию, без угадывания раскладки рулей.
 * @tests T17, смоук E (`tests/browser-smoke.mjs`)
 *
 * Принципы:
 *  1. Устройство управляет машиной только после явного включения и только то,
 *     для которого создан профиль (совпадает deviceId).
 *  2. Для рулей раскладка осей не угадывается: номера осей и полярность педалей
 *     зависят от модели и драйвера, поэтому их задаёт калибровка по шагам.
 *     Готовый профиль есть только у геймпадов со стандартной раскладкой W3C.
 *  3. В Gamepad API ось X отрицательна влево. В проекте угол руля положителен
 *     влево, поэтому по умолчанию swDeg = −ось × диапазон.
 *  4. Ось педали не даёт сигнала, пока её значение ни разу не изменилось:
 *     до первого нажатия многие драйверы отдают 0, и при диапазоне −1…+1
 *     это читалось бы как педаль, нажатая наполовину.
 */

export type GamepadSnapshot = {
  index: number;
  id: string;
  /** "standard" для геймпадов со стандартной раскладкой, иначе пустая строка. */
  mapping: string;
  connected: boolean;
  axes: number[];
  buttons: Array<{ pressed: boolean; value: number }>;
  timestamp: number;
};

export type PedalBinding = {
  source: "none" | "axis" | "button";
  index: number;
  /** Сырое значение оси при отпущенной педали. */
  rest: number;
  /** Сырое значение оси при полностью нажатой педали. */
  full: number;
};

export type GamepadProfile = {
  version: 2;
  enabled: boolean;
  calibrated: boolean;
  deviceId: string;
  steerAxis: number;
  invertSteer: boolean;
  /** Угол руля в симуляторе при полном отклонении оси. */
  steerRangeDeg: number;
  steerDeadzone: number;
  pedalDeadzone: number;
  throttle: PedalBinding;
  brake: PedalBinding;
  /** Номера кнопок; −1 — действие не назначено. */
  buttonEngine: number;
  buttonHandbrake: number;
  buttonSignalLeft: number;
  buttonSignalRight: number;
  buttonGearDrive: number;
  buttonGearReverse: number;
  /** Кнопка сигнала (клаксона); −1 — не назначена. */
  buttonHorn?: number;
};

export type GamepadButtons = {
  engine: boolean;
  handbrake: boolean;
  signalLeft: boolean;
  signalRight: boolean;
  gearDrive: boolean;
  gearReverse: boolean;
  /** Сигнал (клаксон) удерживается. */
  horn: boolean;
};

export type GamepadRead = {
  /** Устройство включено, откалибровано и совпадает с профилем. */
  active: boolean;
  /** Руль отклонён настолько, что перехватывает управление у клавиатуры. */
  steering: boolean;
  throttle: number;
  brake: number;
  steerWheelDeg: number;
  buttons: GamepadButtons;
};

export type AxisArming = { deviceKey: string; baseline: number[]; armed: boolean[] };

const ARM_THRESHOLD = 0.02;
const STEER_ACTIVE_DEG = 1.5;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Симметричная мёртвая зона для руля: дребезг у центра обнуляется, остальной ход растягивается до ±1. */
export function applyDeadzone(value: number, deadzone: number): number {
  const dz = clamp(deadzone, 0, 0.4);
  const abs = Math.abs(value);
  if (abs <= dz) return 0;
  return Math.sign(value) * Math.min(1, (abs - dz) / (1 - dz));
}

/** Мёртвая зона в начале хода педали (0…1). */
function lowDeadzone(t: number, deadzone: number): number {
  const dz = clamp(deadzone, 0, 0.4);
  if (t <= dz) return 0;
  return Math.min(1, (t - dz) / (1 - dz));
}

function noPedal(): PedalBinding {
  return { source: "none", index: -1, rest: 0, full: 1 };
}

function noButtons(): GamepadButtons {
  return {
    engine: false,
    handbrake: false,
    signalLeft: false,
    signalRight: false,
    gearDrive: false,
    gearReverse: false,
    horn: false,
  };
}

/** Профиль «устройство не настроено»: ничего не включено и не назначено. */
export function createDefaultProfile(): GamepadProfile {
  return {
    version: 2,
    enabled: false,
    calibrated: false,
    deviceId: "",
    steerAxis: 0,
    invertSteer: false,
    steerRangeDeg: 540,
    steerDeadzone: 0.02,
    pedalDeadzone: 0.04,
    throttle: noPedal(),
    brake: noPedal(),
    buttonEngine: -1,
    buttonHandbrake: -1,
    buttonSignalLeft: -1,
    buttonSignalRight: -1,
    buttonGearDrive: -1,
    buttonGearReverse: -1,
  };
}

export function isStandardGamepad(snapshot: GamepadSnapshot): boolean {
  return snapshot.mapping === "standard";
}

/**
 * Профиль геймпада со стандартной раскладкой: номера осей и кнопок заданы спецификацией,
 * поэтому калибровка не нужна. Триггеры — аналоговые кнопки 6 (LT) и 7 (RT).
 */
export function presetForStandardGamepad(snapshot: GamepadSnapshot): GamepadProfile {
  return {
    ...createDefaultProfile(),
    calibrated: true,
    deviceId: snapshot.id,
    steerAxis: 0, // левый стик, ось X
    steerDeadzone: 0.1,
    throttle: { source: "button", index: 7, rest: 0, full: 1 },
    brake: { source: "button", index: 6, rest: 0, full: 1 },
    buttonEngine: 9, // Start
    buttonHandbrake: 0, // A
    buttonSignalLeft: 4, // LB
    buttonSignalRight: 5, // RB
    buttonGearDrive: 12, // крестовина вверх
    buttonGearReverse: 13, // крестовина вниз
  };
}

export function createAxisArming(): AxisArming {
  return { deviceKey: "", baseline: [], armed: [] };
}

/**
 * Следит, какие оси уже «ожили». Первый снимок устройства запоминается как исходный;
 * ось считается рабочей после первого заметного изменения. Состояние меняется на месте.
 */
export function updateAxisArming(state: AxisArming, snapshot: GamepadSnapshot | null): AxisArming {
  if (!snapshot || !snapshot.connected) {
    state.deviceKey = "";
    state.baseline = [];
    state.armed = [];
    return state;
  }
  const key = `${snapshot.index}:${snapshot.id}`;
  if (state.deviceKey !== key || state.baseline.length !== snapshot.axes.length) {
    state.deviceKey = key;
    state.baseline = snapshot.axes.slice();
    state.armed = snapshot.axes.map(() => false);
    return state;
  }
  for (let i = 0; i < snapshot.axes.length; i++) {
    if (!state.armed[i] && Math.abs(snapshot.axes[i] - state.baseline[i]) > ARM_THRESHOLD) {
      state.armed[i] = true;
    }
  }
  return state;
}

export function isProfileActive(snapshot: GamepadSnapshot | null, profile: GamepadProfile): boolean {
  return Boolean(
    snapshot &&
      snapshot.connected &&
      profile.enabled &&
      profile.calibrated &&
      profile.deviceId !== "" &&
      snapshot.id === profile.deviceId
  );
}

function readPedal(binding: PedalBinding, snapshot: GamepadSnapshot, arming: AxisArming, deadzone: number): number {
  if (binding.source === "button") {
    const b = snapshot.buttons[binding.index];
    return b ? lowDeadzone(clamp(b.value, 0, 1), deadzone) : 0;
  }
  if (binding.source === "axis") {
    if (!arming.armed[binding.index]) return 0;
    const raw = snapshot.axes[binding.index];
    if (!Number.isFinite(raw)) return 0;
    const span = binding.full - binding.rest;
    if (Math.abs(span) < 0.2) return 0;
    return lowDeadzone(clamp((raw - binding.rest) / span, 0, 1), deadzone);
  }
  return 0;
}

export function readGamepad(
  snapshot: GamepadSnapshot | null,
  profile: GamepadProfile,
  arming: AxisArming
): GamepadRead {
  if (!snapshot || !isProfileActive(snapshot, profile)) {
    return { active: false, steering: false, throttle: 0, brake: 0, steerWheelDeg: 0, buttons: noButtons() };
  }
  const snap = snapshot;
  const rawSteer = snap.axes[profile.steerAxis];
  const shaped = applyDeadzone(Number.isFinite(rawSteer) ? clamp(rawSteer, -1, 1) : 0, profile.steerDeadzone);
  const range = clamp(profile.steerRangeDeg, 90, 540);
  // «+ 0» превращает −0 в 0, чтобы запись ввода не различала их
  const steerWheelDeg = clamp((profile.invertSteer ? shaped : -shaped) * range, -540, 540) + 0;

  const pressed = (index: number): boolean => {
    if (index < 0) return false;
    const b = snap.buttons[index];
    return Boolean(b && (b.pressed || b.value > 0.5));
  };

  return {
    active: true,
    steering: Math.abs(steerWheelDeg) > STEER_ACTIVE_DEG,
    throttle: readPedal(profile.throttle, snap, arming, profile.pedalDeadzone),
    brake: readPedal(profile.brake, snap, arming, profile.pedalDeadzone),
    steerWheelDeg,
    buttons: {
      engine: pressed(profile.buttonEngine),
      handbrake: pressed(profile.buttonHandbrake),
      signalLeft: pressed(profile.buttonSignalLeft),
      signalRight: pressed(profile.buttonSignalRight),
      gearDrive: pressed(profile.buttonGearDrive),
      gearReverse: pressed(profile.buttonGearReverse),
      horn: pressed(profile.buttonHorn ?? -1),
    },
  };
}

// ───────────────────────── Калибровка по шагам ─────────────────────────

export type CalibStep = "steerLeft" | "throttleFull" | "throttleRest" | "brakeFull" | "brakeRest" | "done";

export type CalibState = {
  step: CalibStep;
  /** Снимок устройства на начало текущего шага — от него отсчитывается изменение. */
  baseline: GamepadSnapshot;
  draft: GamepadProfile;
};

export type CalibResult = { state: CalibState; error: string | null };

export const CALIB_PROMPT: Record<CalibStep, string> = {
  steerLeft: "Шаг 1 из 5. Отпустите педали, поверните руль ВЛЕВО и, удерживая, нажмите «Далее».",
  throttleFull: "Шаг 2 из 5. Верните руль прямо. Нажмите ГАЗ до упора и, удерживая, нажмите «Далее».",
  throttleRest: "Шаг 3 из 5. Полностью отпустите ГАЗ и нажмите «Далее».",
  brakeFull: "Шаг 4 из 5. Нажмите ТОРМОЗ до упора и, удерживая, нажмите «Далее».",
  brakeRest: "Шаг 5 из 5. Полностью отпустите ТОРМОЗ и нажмите «Далее».",
  done: "Калибровка завершена.",
};

function cloneSnapshot(s: GamepadSnapshot): GamepadSnapshot {
  return {
    ...s,
    axes: s.axes.slice(),
    buttons: s.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
  };
}

function largestAxisChange(
  base: GamepadSnapshot,
  cur: GamepadSnapshot,
  exclude: readonly number[]
): { index: number; delta: number } {
  let best = { index: -1, delta: 0 };
  const n = Math.min(base.axes.length, cur.axes.length);
  for (let i = 0; i < n; i++) {
    if (exclude.includes(i)) continue;
    const delta = cur.axes[i] - base.axes[i];
    if (Math.abs(delta) > Math.abs(best.delta)) best = { index: i, delta };
  }
  return best;
}

function largestButtonChange(base: GamepadSnapshot, cur: GamepadSnapshot): { index: number; delta: number } {
  let best = { index: -1, delta: 0 };
  const n = Math.min(base.buttons.length, cur.buttons.length);
  for (let i = 0; i < n; i++) {
    const delta = cur.buttons[i].value - base.buttons[i].value;
    if (delta > best.delta) best = { index: i, delta };
  }
  return best;
}

/** Один и тот же орган: та же ось в том же направлении или та же кнопка. */
function isSameControl(a: PedalBinding, b: PedalBinding): boolean {
  if (a.source !== b.source || a.index !== b.index || a.source === "none") return false;
  if (a.source === "button") return true;
  return Math.sign(a.full - a.rest) === Math.sign(b.full - b.rest);
}

/** Начинает калибровку. Настройки чувствительности сохраняются, если устройство то же. */
export function startCalibration(snapshot: GamepadSnapshot, previous: GamepadProfile): CalibState {
  const draft = createDefaultProfile();
  draft.deviceId = snapshot.id;
  if (previous.deviceId === snapshot.id) {
    draft.steerRangeDeg = previous.steerRangeDeg;
    draft.steerDeadzone = previous.steerDeadzone;
    draft.pedalDeadzone = previous.pedalDeadzone;
  }
  return { step: "steerLeft", baseline: cloneSnapshot(snapshot), draft };
}

/**
 * Переход к следующему шагу по текущему снимку устройства.
 * Ничего не предполагает о модели: рулевая ось — та, что изменилась сильнее всего при повороте
 * влево; педаль — ось (кроме рулевой) или аналоговая кнопка с наибольшим изменением.
 * Покой педали снимается отдельным шагом ПОСЛЕ нажатия, когда драйвер уже отдаёт настоящее значение.
 */
export function advanceCalibration(state: CalibState, snapshot: GamepadSnapshot, skipPedal = false): CalibResult {
  const fail = (error: string): CalibResult => ({ state, error });
  if (state.step === "done") return { state, error: null };
  if (snapshot.id !== state.baseline.id) {
    return fail("Устройство сменилось во время калибровки — начните заново.");
  }

  const cur = cloneSnapshot(snapshot);
  const draft: GamepadProfile = {
    ...state.draft,
    throttle: { ...state.draft.throttle },
    brake: { ...state.draft.brake },
  };
  const next = (step: CalibStep): CalibResult => ({ state: { step, baseline: cur, draft }, error: null });
  const finish = (): CalibResult => {
    draft.calibrated = true;
    draft.enabled = true;
    draft.deviceId = snapshot.id;
    return next("done");
  };

  if (state.step === "steerLeft") {
    const change = largestAxisChange(state.baseline, cur, []);
    if (change.index < 0 || Math.abs(change.delta) < 0.25) {
      return fail("Поворот руля не обнаружен: поверните руль влево сильнее и удерживайте.");
    }
    draft.steerAxis = change.index;
    // По стандарту значение оси при повороте влево уменьшается; если выросло — ось перевёрнута
    draft.invertSteer = change.delta > 0;
    return next("throttleFull");
  }

  const pedal: "throttle" | "brake" =
    state.step === "throttleFull" || state.step === "throttleRest" ? "throttle" : "brake";
  const pedalName = pedal === "throttle" ? "газа" : "тормоза";

  if (state.step === "throttleFull" || state.step === "brakeFull") {
    if (skipPedal) {
      draft[pedal] = noPedal();
      return pedal === "throttle" ? next("brakeFull") : finish();
    }
    const axis = largestAxisChange(state.baseline, cur, [draft.steerAxis]);
    const button = largestButtonChange(state.baseline, cur);
    let binding: PedalBinding | null = null;
    if (axis.index >= 0 && Math.abs(axis.delta) >= 0.4) {
      binding = {
        source: "axis",
        index: axis.index,
        rest: state.baseline.axes[axis.index],
        full: cur.axes[axis.index],
      };
    } else if (button.index >= 0 && button.delta >= 0.5) {
      binding = { source: "button", index: button.index, rest: 0, full: 1 };
    }
    if (!binding) {
      return fail(`Нажатие педали ${pedalName} не обнаружено: нажмите до упора и удерживайте.`);
    }
    if (pedal === "brake" && isSameControl(binding, draft.throttle)) {
      return fail("Это педаль газа. Отпустите её и нажмите ТОРМОЗ.");
    }
    draft[pedal] = binding;
    return next(pedal === "throttle" ? "throttleRest" : "brakeRest");
  }

  // Шаги throttleRest / brakeRest: фиксируем настоящее положение покоя
  const binding = draft[pedal];
  if (binding.source === "axis") {
    const rest = cur.axes[binding.index];
    if (!Number.isFinite(rest) || Math.abs(binding.full - rest) < 0.3) {
      return fail(`Педаль ${pedalName} всё ещё нажата: отпустите её полностью.`);
    }
    binding.rest = rest;
  } else if (binding.source === "button") {
    if ((cur.buttons[binding.index]?.value ?? 0) > 0.2) {
      return fail("Кнопка всё ещё нажата: отпустите её.");
    }
  }
  return pedal === "throttle" ? next("brakeFull") : finish();
}

/** Приводит сохранённый профиль к корректному виду; чужие и старые форматы отбрасываются. */
export function sanitizeProfile(raw: unknown): GamepadProfile {
  const base = createDefaultProfile();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  if (r.version !== 2) return base;

  const int = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback;
  };
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  const pedal = (v: unknown): PedalBinding => {
    if (!v || typeof v !== "object") return noPedal();
    const p = v as Record<string, unknown>;
    if (p.source !== "axis" && p.source !== "button") return noPedal();
    return {
      source: p.source,
      index: int(p.index, -1, -1, 31),
      rest: num(p.rest, 0, -1, 1),
      full: num(p.full, 1, -1, 1),
    };
  };

  return {
    version: 2,
    enabled: r.enabled === true,
    calibrated: r.calibrated === true,
    deviceId: typeof r.deviceId === "string" ? r.deviceId : "",
    steerAxis: int(r.steerAxis, 0, 0, 31),
    invertSteer: r.invertSteer === true,
    steerRangeDeg: int(r.steerRangeDeg, 540, 90, 540),
    steerDeadzone: num(r.steerDeadzone, 0.02, 0, 0.3),
    pedalDeadzone: num(r.pedalDeadzone, 0.04, 0, 0.3),
    throttle: pedal(r.throttle),
    brake: pedal(r.brake),
    buttonEngine: int(r.buttonEngine, -1, -1, 31),
    buttonHandbrake: int(r.buttonHandbrake, -1, -1, 31),
    buttonSignalLeft: int(r.buttonSignalLeft, -1, -1, 31),
    buttonSignalRight: int(r.buttonSignalRight, -1, -1, 31),
    buttonGearDrive: int(r.buttonGearDrive, -1, -1, 31),
    buttonGearReverse: int(r.buttonGearReverse, -1, -1, 31),
  };
}
