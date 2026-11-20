/**
 * @module input/keyBindings
 * @layer input
 * @role Сохраняемая клавиатурная раскладка: физические коды, обмен конфликтующих назначений, проверка сохранённых данных.
 * @invariants Уникальные назначения; Escape зарезервирован для выхода; раскладка не меняет физику.
 * @tests tests/shifter-projection.ts, Browser Smoke A2h–A2k.
 */
export const KEY_ACTIONS = [
  ["KeyW", "Газ"], ["KeyS", "Тормоз"], ["KeyA", "Руль влево"], ["KeyD", "Руль вправо"],
  ["ArrowUp", "Селектор / ступень вверх"], ["ArrowDown", "Селектор / ступень вниз"],
  ["ShiftLeft", "Ручной режим / резкое нажатие (левый)"], ["ShiftRight", "Ручной режим / резкое нажатие (правый)"],
  ["KeyI", "Двигатель"], ["Space", "Ручник"], ["KeyB", "Ремень"], ["KeyL", "Фары"],
  ["KeyQ", "Левый поворотник"], ["KeyE", "Правый поворотник"], ["KeyZ", "Аварийка"], ["KeyH", "Сигнал"],
  ["KeyP", "Паркинг P"], ["KeyR", "Задняя R"], ["KeyN", "Нейтраль N"], ["KeyF", "Автомат D"],
  ["ArrowLeft", "Взгляд влево"], ["ArrowRight", "Взгляд вправо"], ["KeyG", "Взгляд на рычаг"],
  ["KeyC", "Следующая камера"], ["Digit1", "Камера сзади"], ["Digit2", "Камера салона"],
  ["Digit3", "Камера сверху"], ["Digit4", "Камера орбиты"], ["Backspace", "Сброс попытки"],
  ["KeyU", "Полный экран"], ["KeyV", "Скрыть / показать интерфейс"], ["KeyO", "Открыть / закрыть настройки"],
] as const;
export type KeyBindings = Record<string, string>;
export const defaultKeyBindings = (): KeyBindings => Object.fromEntries(KEY_ACTIONS.map(([code]) => [code, code]));
export const validBinding = (code: string) => /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Space|Backspace)$/.test(code);
export function bindKey(bindings: KeyBindings, action: string, code: string): KeyBindings {
  if (!(action in defaultKeyBindings()) || !validBinding(code)) return bindings;
  const next = { ...bindings };
  const conflict = Object.keys(next).find((key) => next[key] === code && key !== action);
  if (conflict) next[conflict] = next[action]; // swap: no duplicate assignments or unreachable commands
  next[action] = code;
  return next;
}
export function logicalKey(bindings: KeyBindings, physical: string): string {
  return Object.keys(bindings).find((action) => bindings[action] === physical) ?? "unbound";
}
export function loadKeyBindings(): KeyBindings {
  let result = defaultKeyBindings();
  try {
    const saved = JSON.parse(localStorage.getItem("cdt.keybindings.v1") || "null");
    if (saved && typeof saved === "object") for (const [action, code] of Object.entries(saved)) {
      if (typeof code === "string") result = bindKey(result, action, code);
    }
  } catch { /* corrupt/blocked storage: defaults */ }
  return result;
}
export const keyLabel = (code: string) => ({ ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Пробел" }[code] ?? code.replace(/^Key|^Digit/, ""));
