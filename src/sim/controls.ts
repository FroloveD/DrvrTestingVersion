/**
 * @module sim/controls
 * @layer pure-core
 * @role Блокировки селектора АКПП и стартера ДВС, общие для клавиатуры, HUD, USB-руля и геймпада.
 * @invariants #4 (P механически блокирует движение; запуск ДВС только из P или N), #5 (холодный старт).
 * @tests T25 (src/sim/selfTestExtra.ts)
 */
import type { Gear, InputState } from "./types";
import { clamp, GEAR_MAX_KMH, isManualGear, MAX_FORWARD_GEAR } from "./vehicle";

/**
 * Максимальный модуль скорости (м/с, ≈ 1,26 км/ч), при котором разрешено включить режим P (Parking).
 * Защищает от включения парковочного стопора на ходу.
 */
export const PARK_LOCK_MAX_SPEED_MS = 0.35;

/** Максимальная встречная скорость (м/с, ≈ 1,8 км/ч) для смены направления `R ↔ вперёд`. */
export const DIRECTION_SWITCH_MAX_SPEED_MS = 0.5;

const MANUAL_GEARS: readonly Gear[] = ["1", "2", "3", "4", "5", "6"];

function manualGearOf(n: number): Gear {
  return MANUAL_GEARS[clamp(Math.round(n), 1, MAX_FORWARD_GEAR) - 1];
}

/** Подбирает безопасную ручную передачу по текущей скорости вперёд (при переходе `N → Shift+`). */
function matchManualGearForSpeed(speedMs: number): Gear {
  const kmh = Math.max(0, speedMs * 3.6);
  for (let g = 1; g <= MAX_FORWARD_GEAR; g++) {
    if (kmh < GEAR_MAX_KMH[g] * 0.72) return manualGearOf(g);
  }
  return manualGearOf(MAX_FORWARD_GEAR);
}

/**
 * Проверяет допустимость переключения селектора КПП в режим `next`.
 *
 * Правила:
 * - Включить `P` можно только практически на полной остановке (`|speedMs| <= 0.35` м/с).
 * - Вывести селектор из `P` в `R`, `N`, `D` или `1`..`6` можно только при запущенном двигателе (`engineOn === true`).
 * - Понижение в ручную ступень `1`..`5` блокируется, если текущая скорость превышает безопасный предел оборотов ступени.
 *
 * @param inp Текущее состояние передачи и двигателя.
 * @param speedMs Текущая продольная скорость автомобиля, м/с (`+` вперёд, `−` назад).
 * @param next Целевой режим КПП (`P` | `R` | `N` | `D` | `1`..`6`).
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
    return "Сначала запустите двигатель (I), затем выберите передачу (Shift / R / F)";
  }
  if (isManualGear(next)) {
    const targetNum = Number(next);
    const curNum = isManualGear(inp.gear) ? Number(inp.gear) : MAX_FORWARD_GEAR + 1;
    const fwdKmh = Math.max(0, speedMs * 3.6);
    if (targetNum < curNum && targetNum < MAX_FORWARD_GEAR && fwdKmh > GEAR_MAX_KMH[targetNum] - 3) {
      return `Слишком высокая скорость для M${targetNum} — притормозите тормозом S`;
    }
  }
  return null;
}

/**
 * Секвентальное переключение 6-ступенчатой КПП Shiftronic по клавише `Shift` (`+1` вверх, `−1` вниз).
 *
 * Ряд передач: `P ↔ R ↔ N ↔ M1 ↔ M2 ↔ M3 ↔ M4 ↔ M5 ↔ M6`, а из автоматического `D`
 * нажатие `Shift` плавно переводит коробку в ручной режим Shiftronic (`M1` на месте либо `M(n±1)` на ходу).
 * Возврат в автоматический режим `D` в любой момент выполняется клавишей `F` или кнопкой `D` в HUD.
 */
export function stepGearSequential(
  inp: Pick<InputState, "gear" | "engineOn">,
  speedMs: number,
  autoSubGear: number,
  dir: 1 | -1
): { next: Gear | null; blockedReason: string | null } {
  const cur = inp.gear;
  let candidate: Gear | null = null;

  if (dir === 1) {
    if (cur === "P") candidate = "R";
    else if (cur === "R") candidate = "N";
    else if (cur === "N") {
      if (speedMs < -DIRECTION_SWITCH_MAX_SPEED_MS) {
        return {
          next: null,
          blockedReason: "Остановитесь тормозом S перед включением передней передачи",
        };
      }
      candidate = matchManualGearForSpeed(speedMs);
    } else if (cur === "D") {
      const sub = clamp(Math.round(autoSubGear || 1), 1, MAX_FORWARD_GEAR);
      candidate = speedMs < 0.8 && sub === 1 ? "1" : manualGearOf(Math.min(MAX_FORWARD_GEAR, sub + 1));
    } else if (isManualGear(cur)) {
      const g = Number(cur);
      if (g >= MAX_FORWARD_GEAR) return { next: null, blockedReason: null };
      candidate = manualGearOf(g + 1);
    }
  } else {
    if (cur === "P") return { next: null, blockedReason: null };
    if (cur === "R") candidate = "P";
    else if (cur === "N") {
      if (speedMs > DIRECTION_SWITCH_MAX_SPEED_MS) {
        return {
          next: null,
          blockedReason: "Остановитесь тормозом S перед включением заднего хода R",
        };
      }
      candidate = "R";
    } else if (cur === "D") {
      const sub = clamp(Math.round(autoSubGear || 1), 1, MAX_FORWARD_GEAR);
      if (sub > 1) candidate = manualGearOf(sub - 1);
      else if (speedMs <= DIRECTION_SWITCH_MAX_SPEED_MS) candidate = "N";
      else candidate = "1";
    } else if (isManualGear(cur)) {
      const g = Number(cur);
      if (g > 1) candidate = manualGearOf(g - 1);
      else if (speedMs <= DIRECTION_SWITCH_MAX_SPEED_MS) candidate = "N";
      else {
        return {
          next: null,
          blockedReason: "Включена M1 — для нейтрали притормозите S или нажмите N",
        };
      }
    }
  }

  if (!candidate || candidate === cur) return { next: null, blockedReason: null };
  const blocked = checkGearChange(inp, speedMs, candidate);
  if (blocked) return { next: null, blockedReason: blocked };
  return { next: candidate, blockedReason: null };
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
