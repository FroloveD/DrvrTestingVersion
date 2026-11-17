import type { Gear, TurnSignal } from "../sim/types";
import { clamp, STEER_WHEEL } from "../sim/vehicle";

/**
 * Профили USB-рулей, педалей и геймпадов для автошкол.
 * Ядро симуляции по-прежнему получает только единый InputState и не знает об устройстве.
 */
export type WheelProfileId = "standard" | "wheel_g29" | "wheel_split";

export type GamepadConfig = {
  enabled: boolean;
  profile: WheelProfileId;
  deadzone: number; // 0.01..0.30
  linearity: number; // 1.0 = линейно, 1.5 = мягче около нуля
  wheelRangeDeg: 270 | 540 | 900; // физический угол руля (масштабируется к ±540° Kia Ceed)
  invertPedals: boolean;
};

export const DEFAULT_GAMEPAD_CONFIG: GamepadConfig = {
  enabled: true,
  profile: "standard",
  deadzone: 0.07,
  linearity: 1.15,
  wheelRangeDeg: 900,
  invertPedals: true,
};

export const WHEEL_PROFILE_LABELS: Record<WheelProfileId, { name: string; hint: string }> = {
  standard: {
    name: "Геймпад / XInput",
    hint: "Стик L — руль, RT/LT — газ/тормоз, LB/RB — поворотники, Y/B/X/↓ — D/R/N/P",
  },
  wheel_g29: {
    name: "USB-руль (G29 / G920 / T150)",
    hint: "Ось 0 — руль, ось 2 — газ, ось 5 (или 3) — тормоз, лепестки 4/5 — поворотники",
  },
  wheel_split: {
    name: "USB-руль (оси 0 / 1 / 2)",
    hint: "Ось 0 — руль, ось 1 — газ, ось 2 — тормоз (универсальные школьные педали)",
  },
};

/** Снимок сырых осей/кнопок — отвязан от браузерного типа Gamepad для тестирования в Node. */
export type RawGamepadSnapshot = {
  id: string;
  axes: readonly number[];
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
};

export type MappedGamepadInput = {
  connected: boolean;
  deviceId: string;
  steeringActive: boolean;
  steerWheelDeg: number; // -540..+540 (+ влево, - вправо)
  throttle: number; // 0..1
  brake: number; // 0..1
  gearCommand: Gear | null;
  signalToggle: TurnSignal;
  toggleEngine: boolean;
  toggleHandbrake: boolean;
  toggleBelt: boolean;
  toggleLights: boolean;
  nextButtons: boolean[];
};

export const IDLE_GAMEPAD_INPUT: MappedGamepadInput = {
  connected: false,
  deviceId: "",
  steeringActive: false,
  steerWheelDeg: 0,
  throttle: 0,
  brake: 0,
  gearCommand: null,
  signalToggle: null,
  toggleEngine: false,
  toggleHandbrake: false,
  toggleBelt: false,
  toggleLights: false,
  nextButtons: [],
};

/** Применяет мёртвую зону и нелинейность к оси руля [-1..+1]. */
export function shapeSteerAxis(raw: number, deadzone: number, linearity = 1): number {
  const dz = clamp(deadzone, 0, 0.45);
  const abs = Math.abs(clamp(raw, -1, 1));
  if (abs <= dz) return 0;
  const norm = clamp((abs - dz) / Math.max(0.05, 1 - dz), 0, 1);
  const curved = Math.pow(norm, clamp(linearity, 0.6, 2.5));
  return Math.sign(raw) * curved;
}

/** Преобразует ось педали USB-руля (-1..+1, в покое +1 при invert=true) в диапазон [0..1]. */
export function normalizePedalAxis(raw: number | undefined, invert: boolean, deadzone = 0.04): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const c = clamp(raw, -1, 1);
  // У большинства USB-педалей отпущенная педаль даёт +1, полностью нажатая -1
  const linear = invert ? (1 - c) / 2 : (c + 1) / 2;
  if (linear <= deadzone) return 0;
  return clamp((linear - deadzone) / Math.max(0.05, 1 - deadzone), 0, 1);
}

/** Автоопределение профиля по строке id подключённого устройства. */
export function detectWheelProfile(deviceId: string): WheelProfileId {
  const low = deviceId.toLowerCase();
  if (/(g29|g920|g923|g27|g25|driving force|thrustmaster|t150|t300|fanatec|moza)/i.test(low)) {
    return "wheel_g29";
  }
  if (/(wheel|pedal|racing)/i.test(low)) {
    return "wheel_split";
  }
  return "standard";
}

/**
 * Чистая детерминированная функция перевода состояния геймпада/USB-руля
 * в команды для InputState (соблюдает инвариант №1/№6: влево = +swDeg, вправо = -swDeg).
 */
export function mapGamepadSnapshot(
  snap: RawGamepadSnapshot | null,
  config: GamepadConfig,
  prevButtons: readonly boolean[] = []
): MappedGamepadInput {
  if (!snap || !config.enabled) {
    return IDLE_GAMEPAD_INPUT;
  }

  // Ось 0: -1 = влево, +1 = вправо → инвертируем знак под +X влево (+swDeg)
  const shaped = shapeSteerAxis(snap.axes[0] ?? 0, config.deadzone, config.linearity);
  const steeringActive = Math.abs(shaped) > 0;
  // На рулях 270°/540°/900° полный ход оси соответствует полному вывороту ±540° виртуального Ceed
  const rangeGain = config.wheelRangeDeg === 270 ? 1.0 : 1.0;
  const steerWheelDeg = clamp(
    Number((-shaped * STEER_WHEEL.maxDeg * rangeGain).toFixed(1)),
    -STEER_WHEEL.maxDeg,
    STEER_WHEEL.maxDeg
  );

  // Педали газа и тормоза по выбранному профилю
  let throttle = 0;
  let brake = 0;
  const btnVal = (i: number) => clamp(snap.buttons[i]?.value ?? 0, 0, 1);

  if (config.profile === "standard") {
    throttle = btnVal(7); // RT / R2
    brake = btnVal(6); // LT / L2
  } else if (config.profile === "wheel_g29") {
    const brakeAxis = snap.axes.length > 5 ? snap.axes[5] : snap.axes[3];
    throttle = Math.max(normalizePedalAxis(snap.axes[2], config.invertPedals), btnVal(7));
    brake = Math.max(normalizePedalAxis(brakeAxis, config.invertPedals), btnVal(6));
  } else {
    throttle = Math.max(normalizePedalAxis(snap.axes[1], config.invertPedals), btnVal(7));
    brake = Math.max(normalizePedalAxis(snap.axes[2], config.invertPedals), btnVal(6));
  }

  // Фронты нажатий кнопок (однократное срабатывание без дребезга)
  const nextButtons = snap.buttons.map((b) => Boolean(b?.pressed));
  const justPressed = (idx: number) => Boolean(nextButtons[idx] && !prevButtons[idx]);

  // Селектор АКПП: D-Pad Down (13) -> P, B/Circle (1) -> R, X/Square (2) -> N, Y/Triangle (3) -> D
  let gearCommand: Gear | null = null;
  if (justPressed(13)) gearCommand = "P";
  else if (justPressed(1)) gearCommand = "R";
  else if (justPressed(2)) gearCommand = "N";
  else if (justPressed(3)) gearCommand = "D";

  // Поворотники: левый лепесток/LB (4) -> left (+X), правый лепесток/RB (5) -> right (-X), D-Pad Up (12) -> hazard
  let signalToggle: TurnSignal = null;
  if (justPressed(4)) signalToggle = "left";
  else if (justPressed(5)) signalToggle = "right";
  else if (justPressed(12)) signalToggle = "hazard";

  return {
    connected: true,
    deviceId: snap.id.trim().slice(0, 48),
    steeringActive,
    steerWheelDeg,
    throttle: Number(throttle.toFixed(3)),
    brake: Number(brake.toFixed(3)),
    gearCommand,
    signalToggle,
    toggleHandbrake: justPressed(0), // A / Cross — ручник
    toggleEngine: justPressed(9), // Start / Options — ДВС
    toggleBelt: justPressed(8), // Back / Share — ремень
    toggleLights: justPressed(14), // D-Pad Left — ближний свет
    nextButtons,
  };
}

/** Тонкий браузерный адаптер для опроса первого подключённого USB-руля или геймпада. */
export class BrowserGamepadPoller {
  private prevButtons: boolean[] = [];

  poll(config: GamepadConfig): MappedGamepadInput {
    if (!config.enabled || typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      this.prevButtons = [];
      return IDLE_GAMEPAD_INPUT;
    }
    const list = navigator.getGamepads();
    let active: Gamepad | null = null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (g && g.connected) {
          active = g;
          break;
        }
      }
    }
    if (!active) {
      this.prevButtons = [];
      return IDLE_GAMEPAD_INPUT;
    }
    const snap: RawGamepadSnapshot = {
      id: active.id,
      axes: active.axes,
      buttons: active.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
    };
    const mapped = mapGamepadSnapshot(snap, config, this.prevButtons);
    this.prevButtons = mapped.nextButtons;
    return mapped;
  }
}
