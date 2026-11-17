import type { Gear, InputState } from "./types";

/**
 * Проверка переключения АКПП. Общая для клавиатуры, руля и геймпада.
 * Возвращает текст отказа или null, если переключение разрешено.
 */
export function checkGearChange(
  inp: Pick<InputState, "gear" | "engineOn">,
  speedMs: number,
  next: Gear
): string | null {
  if (next === "P" && Math.abs(speedMs) > 0.35) {
    return "Парковку P можно включить только после полной остановки (тормоз S)";
  }
  if (inp.gear === "P" && next !== "P" && !inp.engineOn) {
    return "Сначала запустите двигатель (I), затем выберите R или D";
  }
  return null;
}
