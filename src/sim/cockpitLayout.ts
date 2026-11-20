/**
 * @module sim/cockpitLayout
 * @layer pure-core
 * @role Раскладка невидимых зон клика по органам салона в координатах кузова: руль, 7" ШГУ, шайбы, кулиса АКПП.
 * @invariants #1 (единицы СИ, X — влево, Y — вверх, Z — вперёд), #7 (чистое ядро: без DOM и Three.js).
 * @tests T41 (`src/sim/selfTestExtra.ts`) — зона сигнала на руле не перекрывает ШГУ, шайбы и кулису.
 *
 * Кабина у всех машин парка одна и та же (щиток, руль, консоль), поэтому раскладка — константы.
 * Раньше зона клика «сигнал на руле» была 23 см и перекрывала кулису АКПП и консоль ШГУ:
 * клик по рычагу и по шайбе TUNE уходил в клаксон (смоук K7c/K7d это поймал).
 */

/** Осевой параллелепипед зоны клика: центр и полные размеры, м. */
export type PickBox = {
  id: string;
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
};

/** Центр руля в кузове: X — влево, Y — над полом салона, Z относительно середины базы. */
export const WHEEL_PICK_CENTER = { x: 0.414, y: 0.86, z: 0.5 } as const;
/** Радиус обода руля, м (для проверки, что зона сигнала — только ступица). */
export const WHEEL_RIM_RADIUS = 0.172;

/** Зона сигнала: накладка ступицы, заметно уже обода. */
export const HORN_PICK: PickBox = {
  id: "horn",
  cx: WHEEL_PICK_CENTER.x,
  cy: WHEEL_PICK_CENTER.y,
  cz: WHEEL_PICK_CENTER.z,
  sx: 0.062,
  sy: 0.062,
  sz: 0.028,
};

/** Зона 7" ШГУ на центральной консоли (ориентир по рига `vehiclesAndPeds`). */
export const HEAD_UNIT_PICK: PickBox = {
  id: "headunit",
  cx: 0,
  cy: 0.898,
  cz: 0.405,
  sx: 0.238,
  sy: 0.152,
  sz: 0.03,
};

/** Кулиса АКПП: площадка P–R–N–D и рычаг. */
export const SHIFTER_PICK: PickBox = {
  id: "shifter",
  cx: 0.022,
  cy: 0.62,
  cz: 0.49,
  sx: 0.13,
  sy: 0.16,
  sz: 0.22,
};

/** Пересекаются ли две зоны клика (по осям кузова, с допуском 0 — нужен строгий зазор). */
export function pickBoxesOverlap(a: PickBox, b: PickBox, gap = 0): boolean {
  return (
    Math.abs(a.cx - b.cx) < (a.sx + b.sx) / 2 + gap &&
    Math.abs(a.cy - b.cy) < (a.sy + b.sy) / 2 + gap &&
    Math.abs(a.cz - b.cz) < (a.sz + b.sz) / 2 + gap
  );
}

/** Все зоны органов салона, которые лежат рядом с рулём (для проверки зазоров). */
export const COCKPIT_PICK_ZONES: readonly PickBox[] = [HORN_PICK, HEAD_UNIT_PICK, SHIFTER_PICK];
