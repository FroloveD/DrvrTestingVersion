/**
 * @module render/cockpitFraming
 * @layer three-render
 * @role Кадрировка вида из салона «как на референсе»: поза глаз водителя, наклон на дорогу, вертикальный обрез и FOV по паспорту конкретной машины.
 * @invariants #1 (единицы СИ), #9 (не трогает ядро физики — только камеру), #14 (ракурс воспроизводим численно, без подбора «на глаз»).
 * @tests T39 (`src/sim/selfTestExtra.ts`) — композиция кадра: руль снизу по центру, дорога и салонное зеркало в верхней трети.
 *
 * Референс (`/tmp/arena-coding-uploads/image-6.png`) задаёт композицию кадра:
 * - нижняя граница обода руля ≈ 93 % высоты, верх обода ≈ 57 %, ступица ≈ 77 % по вертикали;
 * - руль по горизонтали чуть левее центра (водительское место, левый руль);
 * - крыша видна узкой полосой сверху, капот почти не виден;
 * - салонное зеркало целиком в кадре в верхней трети;
 * - левая стойка и боковое зеркало в левой четверти кадра.
 *
 * Все позы выражены в координатах кузова (X — влево, Y — вверх, Z — вперёд), поэтому
 * кадр автоматически переезжает вместе с машиной: у Picanto глаз ниже и ближе к рулю,
 * у Sorento — выше и дальше. Сцена только читает результат.
 */
import { getPlayerCar } from "../sim/playerCar";
import { clamp } from "../sim/vehicle";

const degToRad = (deg: number) => (deg * Math.PI) / 180;

/** Геометрия кадра из салона для одной машины (все углы — радианы, длины — метры). */
export type CockpitFraming = {
  /** Поза глаз водителя в координатах кузова. */
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** Наклон взгляда на дорогу (рад). */
  pitchRad: number;
  /** Вертикальный FOV камеры (град) для базового ракурса. */
  fovDeg: number;
  /** Доля ширины кузова, на которой стоит водитель (левый руль — от 0,20 до 0,24). */
  eyeSideFrac: number;
  /** Высота глаз над полом салона (м) — для проверки «не ниже руля» в самотесте. */
  eyeAboveWheelM: number;
};

/** Центр и верх обода руля в координатах кузова (сверено с геометрией `vehiclesAndPeds`). */
export const WHEEL_CENTER_Y = 0.905;
export const WHEEL_RADIUS_M = 0.172;
const WHEEL_X = 1.8 * 0.23;
const WHEEL_TOP_Y = WHEEL_CENTER_Y + WHEEL_RADIUS_M;
const WHEEL_Z = (0.88 - 0.78) / 2 + 0.485;
/** Целевое положение верхней точки обода: 42 % высоты кадра от низа (на референсе ≈ 43 %). */
export const TARGET_WHEEL_TOP_V = 0.42;

/**
 * Кадрировка для машины: по умолчанию — учебный Ceed JD, поза которого выверена по референсу.
 * Больше колея и база → глаз выше и дальше от руля; у SUV кабина просторнее, поэтому FOV шире.
 */
export function cockpitFramingFor(carId?: string | null): CockpitFraming {
  return rawFramingFor(carId);
}

/**
 * Поза по паспорту машины без подгонки композиции (высота глаз, вынос, FOV).
 * Экспортируется для самотеста: он проверяет, что масштабирование по классу машины работает
 * и что подгонка `cockpitFramingFor` не «выключает» разницу между машинами.
 */
export function rawFramingFor(carId?: string | null): CockpitFraming {
  const car = getPlayerCar(carId);
  // Эталон — Ceed JD: eye (0,405; 1,195; −0,06) при ширине 1,80 м и высоте 1,447 м
  const widthScale = car.width / 1.8;
  // Высота глаз растёт с кузовом мягко (0,35 от прироста высоты): щиток, руль и зеркало в риге
  // от машины не меняются, поэтому большой глаз-скачок ломал бы кадр. Ceed 1,447 → 1,195 м (референс),
  // Picanto 1,485 → 1,208 м, Sorento 1,70 → 1,284 м.
  const eyeY = 1.195 + (car.height - 1.447) * 0.35;
  const eyeSideFrac = 0.225;
  const eyeX = car.width * eyeSideFrac; // левый руль: глаз слева от оси кузова (X — влево)
  // Чем длиннее база, тем больше салон: сиденье отодвигается от руля (в кузове это −Z),
  // поэтому водитель Sorento сидит дальше от щитка, чем в Picanto, при том же кадре.
  const eyeZ = -0.06 - (car.wheelbase - 2.65) * 0.34;
  // Наклон считается аналитически: верх обода руля обязан попадать в TARGET_WHEEL_TOP_V
  // независимо от позы глаза, поэтому кадр любой машины повторяет референс.
  // В базисе камеры точка даёт camY = dy·cosφ + dz·sinφ, camZ = dz·cosφ − dy·sinφ (φ — взгляд вниз),
  // а цель кадра задаёт camY / camZ = K. Отсюда tanφ = −(dy − K·dz) / (dz + K·dy).
  const tanHalfV = Math.tan(degToRad(68 * 0.5));
  const K = (TARGET_WHEEL_TOP_V - 0.5) * 2 * tanHalfV;
  const dy = WHEEL_TOP_Y - eyeY;
  const dz = WHEEL_Z - eyeZ;
  const pitchRad = clamp(-Math.atan2(-(dy - K * dz), dz + K * dy), -0.45, 0.05);
  // Узкий кузов — стойки ближе к глазу, поэтому чуть шире FOV: капот не перекрывает дорогу
  const fovDeg = clamp(68 * (0.94 + 0.06 * widthScale), 60, 76);
  return {
    eyeX,
    eyeY,
    eyeZ,
    pitchRad,
    fovDeg,
    eyeSideFrac,
    eyeAboveWheelM: eyeY - WHEEL_CENTER_Y,
  };
}

/**
 * Проекция точки кузова в кадр камеры: возвращает `{ u, v, depth }` в долях кадра (0…1, v — снизу вверх)
 * и расстояние по оси взгляда. Используется самотестом `T39`, чтобы проверять композицию численно.
 */
export function projectCockpitPoint(
  framing: CockpitFraming,
  point: { x: number; y: number; z: number },
  fovDeg: number = framing.fovDeg,
  aspect = 16 / 9
): { u: number; v: number; depth: number } {
  // Камера смотрит вперёд по +Z кузова с наклоном pitchRad: переводим в её базис
  const dx = point.x - framing.eyeX;
  const dy = point.y - framing.eyeY;
  const dz = point.z - framing.eyeZ;
  const cp = Math.cos(framing.pitchRad);
  const sp = Math.sin(framing.pitchRad);
  // В базисе камеры: x — вправо (кузов: −X), y — вверх, z — вперёд
  const camX = -dx;
  // Соглашение камеры three.js: pitchRad > 0 — взгляд вверх, < 0 — вниз (как headPitch в сцене).
  // При взгляде вниз дальняя точка уходит вверх кадра: camY = dy·cosφ − dz·sinφ, camZ = dz·cosφ + dy·sinφ
  const camY = dy * cp - dz * sp;
  const camZ = dz * cp + dy * sp;
  const tanHalfV = Math.tan(degToRad(fovDeg * 0.5));
  const tanHalfH = tanHalfV * aspect;
  const depth = Math.max(1e-4, camZ);
  return {
    u: 0.5 + camX / depth / (2 * tanHalfH),
    v: 0.5 + camY / depth / (2 * tanHalfV),
    depth,
  };
}

/** Куда в кадре попадает обод руля и ступица (для самотеста и отладки кадрировки). */
export function cockpitWheelBand(framing: CockpitFraming, fovDeg: number = framing.fovDeg) {
  // Колесо строится для эталонного кузова Ceed (WHEEL_X/WHEEL_Z): композицию кадра
  // мы держим неизменной для всех машин, от неё зависит лишь поза глаза.
  const cx = WHEEL_X;
  const cy = WHEEL_CENTER_Y;
  const cz = WHEEL_Z;
  const top = projectCockpitPoint(framing, { x: cx, y: cy + WHEEL_RADIUS_M, z: cz }, fovDeg);
  const bottom = projectCockpitPoint(framing, { x: cx, y: cy - WHEEL_RADIUS_M, z: cz }, fovDeg);
  const hub = projectCockpitPoint(framing, { x: cx, y: cy, z: cz }, fovDeg);
  return { topV: top.v, bottomV: bottom.v, hubU: hub.u, hubV: hub.v };
}
