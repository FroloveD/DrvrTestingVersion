/**
 * @module input/keyBindings
 * @layer input
 * @role Сохраняемая клавиатурная раскладка: физические коды, проверка конфликтующих назначений, проверка сохранённых данных.
 * @invariants Уникальные назначения; Escape зарезервирован для выхода; раскладка не меняет физику.
 * @tests tests/shifter-projection.ts, Browser Smoke A2h–A2k.
 */
export const KEY_ACTIONS = [
  ["KeyW", "Газ"], ["KeyS", "Тормоз"], ["KeyA", "Руль влево"], ["KeyD", "Руль вправо"],
  ["ArrowUp", "Газ (альтернатива)"], ["ArrowDown", "Тормоз (альтернатива)"],
  ["ShiftLeft", "Модификатор (левый)"], ["ShiftRight", "Модификатор (правый)"],
  ["KeyI", "Двигатель"], ["Space", "Ручник"], ["KeyB", "Ремень"], ["KeyL", "Фары"],
  ["KeyQ", "Левый поворотник"], ["KeyE", "Правый поворотник"], ["KeyZ", "Аварийка"],
  ["KeyP", "Паркинг P"], ["KeyR", "Задняя R"], ["KeyN", "Нейтраль N"], ["KeyF", "Автомат D"],
  ["ArrowLeft", "Руль влево / взгляд влево"], ["ArrowRight", "Руль вправо / взгляд вправо"],
  ["KeyG", "Взгляд на рычаг"], ["KeyC", "Следующая камера"],
  ["Digit1", "Камера сзади"], ["Digit2", "Камера салона"], ["Digit3", "Камера сверху"], ["Digit4", "Камера орбиты"],
  ["Backspace", "Сброс попытки"], ["KeyH", "Скрыть / показать интерфейс"], ["KeyO", "Открыть / закрыть настройки"],
] as const;
export type KeyBindings = Record<string, string>;
export const defaultKeyBindings = (): KeyBindings => Object.fromEntries(KEY_ACTIONS.map(([code]) => [code, code]));
export const validBinding = (code: string) => /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Space|Backspace)$/.test(code);
/** Полная проверка раскладки, в том числе вручную повреждённого localStorage. */
export function bindingErrors(bindings: KeyBindings): string[] {
  const errors: string[] = [];
  const owners = new Map<string, string>();
  for (const [action, label] of KEY_ACTIONS) {
    const code = bindings[action];
    if (typeof code !== "string" || !validBinding(code)) { errors.push(`${label}: недопустимая клавиша`); continue; }
    const owner = owners.get(code);
    if (owner) errors.push(`${keyLabel(code)}: ${owner} / ${label}`);
    else owners.set(code, label);
  }
  for (const action of Object.keys(bindings)) {
    if (!KEY_ACTIONS.some(([key]) => key === action)) errors.push(`Неизвестная команда: ${action}`);
  }
  return errors;
}
export function bindingConflict(bindings: KeyBindings, action: string, code: string): string | null {
  const owner = KEY_ACTIONS.find(([key]) => key !== action && bindings[key] === code);
  return owner ? `Клавиша ${keyLabel(code)} уже назначена: «${owner[1]}». Сначала освободите её.` : null;
}
export function bindKey(bindings: KeyBindings, action: string, code: string): KeyBindings {
  if (!KEY_ACTIONS.some(([key]) => key === action) || !validBinding(code) || bindingErrors(bindings).length || bindingConflict(bindings, action, code)) return bindings;
  return { ...bindings, [action]: code };
}
export function logicalKey(bindings: KeyBindings, physical: string): string {
  const matches = KEY_ACTIONS.filter(([action]) => bindings[action] === physical);
  // Fail closed: даже повреждённая раскладка не выбирает произвольную команду из конфликта.
  return matches.length === 1 ? matches[0][0] : "unbound";
}
export function restoreKeyBindings(saved: unknown): KeyBindings {
  const defaults = defaultKeyBindings();
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
  const merged = { ...defaults, ...saved } as KeyBindings;
  return bindingErrors(merged).length ? defaults : merged;
}
export function loadKeyBindings(): KeyBindings {
  try { return restoreKeyBindings(JSON.parse(localStorage.getItem("cdt.keybindings.v1") || "null")); }
  catch { return defaultKeyBindings(); }
}
export const keyLabel = (code: string) => ({ ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Пробел" }[code] ?? code.replace(/^Key|^Digit/, ""));
