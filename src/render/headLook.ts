/**
 * @module render/headLook
 * @layer three-render
 * @role Три точки внимания водителя (левое зеркало → дорога с салонным зеркалом → правое зеркало) и инерция шеи для взгляда из салона.
 * @invariants #1 (углы в радианах от оси `+Z` кузова), #13 (без внешних ассетов).
 * @tests Самотест T37 (`src/sim/selfTestExtra.ts`), смоук K9 (`tests/browser-smoke.mjs`).
 *
 * Геометрия детентов считается по реальному салону Kia Ceed JD, а не «на глаз»:
 * глаза водителя в точке (0.225·W, 1.195, −0.06) → (0.405; 1.195; −0.06);
 * центр левого зеркала — (W/2 + 0.12 − 0.016; beltY + 0.118; centerShiftZ + 0.66) → (1.02; 0.958; 0.71).
 * Вектор (0.615; −0.237; 0.77) даёт азимут atan2(0.615, 0.77) = 38,6° и наклон вниз 13,3° —
 * именно эти углы и зашиты в `MIRROR_DEG`, чтобы в центре кадра было полотно зеркала, а не пустая стойка.
 */

/** Три точки внимания: дорога (+ салонное зеркало в верхней трети кадра) и два боковых зеркала. */
export const HEAD_DETENTS = [
  { id: "left", label: "Левое зеркало", short: "ЛЗ", mirror: true },
  { id: "road", label: "Дорога + салонное зеркало", short: "Дорога", mirror: false },
  { id: "right", label: "Правое зеркало", short: "ПЗ", mirror: true },
] as const;

export type HeadDetentId = (typeof HEAD_DETENTS)[number]["id"];

export const HEAD_TURN = {
  /** Угол на боковое зеркало по азимуту, градусы (см. геометрию выше: 38,6°). */
  MIRROR_DEG: 39,
  /** Наклон на полотно зеркала вниз, градусы (13,3°). */
  MIRROR_PITCH_DEG: 13,
  /** Базовый наклон взгляда на дорогу, рад (−3,2°): салонное зеркало остаётся в верхней трети. */
  PITCH_RAD: -0.056,
  /** Предел свободного обзора мышью: ±100° по азимуту (шея + поворот корпуса). */
  maxDeg: 100,
  minPitchDeg: -52,
  maxPitchDeg: 26,
  /** Постоянная времени инерции шеи: довод до цели за ~0,18 с (3τ). */
  TAU_S: 0.055,
  /** Взгляд на консоль 7" ШГУ и рычаг АКПП (детент не меняется, возврат — туда же, где были). */
  SHIFTER_DEG: 47,
  SHIFTER_PITCH_DEG: 40,
  /** Перевод в радианы для сцены. */
  get MIRROR_RAD() {
    return (this.MIRROR_DEG * Math.PI) / 180;
  },
  get maxRad() {
    return (this.maxDeg * Math.PI) / 180;
  },
  get minPitchRad() {
    return (this.minPitchDeg * Math.PI) / 180;
  },
  get maxPitchRad() {
    return (this.maxPitchDeg * Math.PI) / 180;
  },
  get SHIFTER_RAD() {
    return (this.SHIFTER_DEG * Math.PI) / 180;
  },
  get SHIFTER_PITCH_RAD() {
    return (this.SHIFTER_PITCH_DEG * Math.PI) / 180;
  },
} as const;

/** Детент → целевой азимут головы в радианах (−1 правое, 0 дорога, +1 левое). */
export function detentYawRad(detent: -1 | 0 | 1): number {
  return detent * HEAD_TURN.MIRROR_RAD;
}

/**
 * Один шаг инерции шеи: голова подтягивается к цели с постоянной времени `tau`.
 * `dt` — РЕАЛЬНОЕ время кадра (не фиксированные 1/60): на медленной машине или в headless
 * без GPU довод обязан занимать те же ~0,18 с, а не растягиваться на секунды.
 * Возвращает новое значение и флаг «уже на цели» (для снапа без дрожания).
 */
export function dampedHeadStep(current: number, target: number, dtSec: number, tauSec: number): number {
  const dt = Math.max(0, dtSec);
  const tau = Math.max(1e-4, tauSec);
  // Дробим длинный кадр на подшаги ≤ τ/2: явная экспонента устойчива и даёт тот же результат,
  // что и серия коротких кадров (иначе на 12 FPS голова «переезжает» за 2 кадра вместо 3τ).
  const steps = Math.max(1, Math.ceil(dt / (tau * 0.5)));
  const sub = dt / steps;
  let value = current;
  for (let i = 0; i < steps; i++) {
    value += (target - value) * Math.min(1, sub / tau);
  }
  return Math.abs(target - value) < 1e-4 ? target : value;
}

/**
 * Детент → подпись для HUD. В массиве `HEAD_DETENTS` порядок «левое − дорога − правое»,
 * то есть индекс = detent + 1, а не сам detent.
 */
export function detentLabel(detent: -1 | 0 | 1): string {
  if (detent > 0) return HEAD_DETENTS[0].short;
  if (detent < 0) return HEAD_DETENTS[2].short;
  return HEAD_DETENTS[1].short;
}
