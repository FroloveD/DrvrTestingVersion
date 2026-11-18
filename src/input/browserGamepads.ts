/**
 * @module input/browserGamepads
 * @layer input-browser
 * @role Тонкая обёртка над `navigator.getGamepads()` и хранением профиля `cdt.gamepad.profile.v2` в `localStorage`.
 * @tests Смоук E (`tests/browser-smoke.mjs`)
 */
import { createDefaultProfile, sanitizeProfile, type GamepadProfile, type GamepadSnapshot } from "./gamepad";

const PROFILE_KEY = "cdt.gamepad.profile.v2";
/** Ключ прежнего формата: раскладка в нём угадывалась и была неверной — не используется. */
const OLD_MAPPING_KEY = "cdt.gamepad.mapping.v1";

function toSnapshot(pad: Gamepad): GamepadSnapshot {
  return {
    index: pad.index,
    id: pad.id,
    mapping: pad.mapping,
    connected: pad.connected,
    axes: Array.from(pad.axes),
    buttons: Array.from(pad.buttons, (b) => ({ pressed: b.pressed, value: b.value })),
    timestamp: pad.timestamp,
  };
}

/**
 * Снимок подключённого устройства. Если задан preferredId и такое устройство подключено,
 * возвращается оно; иначе — первое подключённое (профиль к нему не применится из-за другого id).
 * Браузер показывает устройство только после нажатия кнопки на нём.
 */
export function readBrowserGamepad(preferredId = ""): GamepadSnapshot | null {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return null;
  let pads: ReadonlyArray<Gamepad | null>;
  try {
    pads = navigator.getGamepads();
  } catch {
    return null; // доступ запрещён политикой страницы
  }
  let first: Gamepad | null = null;
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    if (preferredId && pad.id === preferredId) return toSnapshot(pad);
    if (!first) first = pad;
  }
  return first ? toSnapshot(first) : null;
}

export function loadGamepadProfile(): GamepadProfile {
  try {
    localStorage.removeItem(OLD_MAPPING_KEY);
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? sanitizeProfile(JSON.parse(raw)) : createDefaultProfile();
  } catch {
    return createDefaultProfile();
  }
}

export function saveGamepadProfile(profile: GamepadProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // хранилище недоступно: профиль действует до закрытия вкладки
  }
}
