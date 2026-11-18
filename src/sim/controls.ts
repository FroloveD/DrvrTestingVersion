/**
 * @module sim/controls
 * @layer pure-core
 * @role Блокировки селектора АКПП и стартера ДВС, общие для клавиатуры, HUD, USB-руля и геймпада.
 * @invariants #4 (P механически блокирует движение; запуск ДВС только из P или N), #5 (холодный старт).
 * @tests T25 (src/sim/selfTestExtra.ts)
 */
import type { Gear, InputState } from "./types";

/**
 * Максимальный модуль скорости (м/с, ≈ 1,26 км/ч), при котором разрешено включить режим P (Parking).
 * Защищает от включения парковочного стопора на ходу.
 */
export const PARK_LOCK_MAX_SPEED_MS = 0.35;

/**
 * Проверяет допустимость переключения селектора АКПП в режим `next`.
 *
 * Правила:
 * - Включить `P` можно только практически на полной остановке (`|speedMs| <= 0.35` м/с).
 * - Вывести селектор из `P` в `R`, `N` или `D` можно только при запущенном двигателе (`engineOn === true`).
 *
 * @param inp Текущее состояние передачи и двигателя.
 * @param speedMs Текущая продольная скорость автомобиля, м/с (`+` вперёд, `−` назад).
 * @param next Целевой режим АКПП (`P` | `R` | `N` | `D` | `1`..`5`).
 * @returns Русскоязычный текст отказа для уведомления в HUD либо `null`, если переключение разрешено.
 */
export function checkGearChange(
  inp: Pick<InputState, "gear" | "engineOn">,
  speedMs: number,
  next: Gear
): string | null {
  if (next === "P" && Math.abs(speedMs) > PARK_LOCK_MAX_SPEED_MS) {
    return "Парковку P можно включить только после полной остановки (тормоз S)";
  }
  if (inp.gear === "P" && next !== "P" && !inp.engineOn) {
    return "Сначала запустите двигатель (I), затем выберите R или D";
  }
  return null;
}

/**
 * Проверяет допустимость переключения состояния двигателя (запуск / остановка).
 *
 * Запуск разрешён строго в режимах `P` или `N` (инвариант #4); заглушить двигатель
 * можно в любом положении селектора.
 *
 * @param inp Текущее состояние передачи и двигателя.
 * @returns Текст отказа для уведомления в HUD либо `null`, если действие разрешено.
 */
export function checkEngineToggle(inp: Pick<InputState, "gear" | "engineOn">): string | null {
  if (!inp.engineOn && inp.gear !== "P" && inp.gear !== "N") {
    return "Запуск двигателя возможен только в P (Parking) или N";
  }
  return null;
}
