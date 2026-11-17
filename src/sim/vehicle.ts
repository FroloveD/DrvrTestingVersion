import type {
  CrosswalkDef,
  Gear,
  ParkedModelKey,
  PedestrianPose,
  TurnSignal,
  TrafficLightPhase,
  TrafficSignalDef,
  Vec2,
} from "./types";

// Параметры автомобиля игрока Kia Ceed JD (DEV_PROMPTS, п. 2.1):
// база L = 2.65 м, свес передний 0.88 м, задний 0.78 м (общая длина 4.31 м),
// ширина 1.80 м, высота 1.447 м, колея T = 1.57 м.
// Внутреннее колесо до 40°, центральный угол maxSteer ≈ 30.11°, внешнее ≈ 26.2°.
/**
------------------------------------------------
-->Разбор всех оставшихся констант:
1. Объект CAR (Параметры автомобиля)
Это базовые физические и геометрические характеристики машины (на примере Kia Ceed JD):
    model: Название модели автомобиля и категория прав (кат. B).
    wheelbase: Колёсная база (2.65 м) — расстояние между центрами передней и задней осей колёс.
    track: Колея (1.57 м) — расстояние между колесами одной оси.
    frontOverhang / rearOverhang: Передний (0.88 м) и задний (0.78 м) свесы кузова (участки машины от осей колёс до крайних точек бамперов).
    length: Общая длина автомобиля (4.31 м), рассчитанная как сумма базы и обоих свесов.
    width / height: Ширина (1.8 м) и высота (1.447 м) кузова.
    wheelRadius / wheelWidth: Радиус (0.315 м) и ширина (0.215 м) колеса (шины).
    maxInnerDeg: Максимальный угол поворота внутреннего колеса в градусах (вы только что меняли его на 40).
    maxSteer: Центральный угол поворота (в радианах), вычисляемый по геометрии Аккермана. Он ограничивает общий угол поворота управляемых колес.
    rollRes: Коэффициент сопротивления качению (0.34).
    brakeDecel / handbrakeDecel: Интенсивность замедления при обычном торможении (6.2 м/с²) и при использовании ручного тормоза (8.5 м/с²).

2. Объект STEER_WHEEL (Параметры рулевого колеса)
Настраивает поведение виртуального руля, который крутит игрок:
    maxDeg: 540: Максимальный угол поворота руля в одну сторону — 540∘ (полтора оборота от центра до упора, то есть всего 3 оборота от упора до упора).
    ratio: Передаточное число рулевого управления (рассчитывается автоматически). Показывает, на сколько градусов нужно повернуть руль, чтобы колеса повернулись на 1∘1∘.
    keyRateDegPerSec: 340: Скорость поворота руля с клавиатуры (в градусах в секунду), если игрок управляет кнопками, а не мышкой или геймпадом.
    selfCenterRate: 220: Скорость возврата руля в центральное положение (самовозврат), когда игрок отпускает клавиши управления.

3. VEHICLE_DIMS (Габариты автопарка)
Словарь с размерами различных моделей автомобилей, которые используются для трафика или парковочных сценариев (включая Kia Picanto, Rio, Ceed, XCeed и Sorento). Для каждой машины здесь прописаны:
    length, width, height: Габаритные размеры кузова.
    wheelbase: Длина колёсной базы.
    name: Читаемое название модели.

4. AUTO_UP и AUTO_DOWN (Пороги АКПП)
Массивы скоростей (в км/ч), по которым автоматическая коробка передач переключает передачи вверх и вниз:
    AUTO_UP = [0, 18, 34, 52, 74, 999]: Скоростные пороги для перехода на более высокую передачу (например, с 1-й на 2-ю коробка переключится при достижении 18 км/ч).
    AUTO_DOWN = [0, 0, 12, 26, 43, 62]: Скоростные пороги для понижения передачи при замедлении машины.
5. FIXED_DT
    FIXED_DT = 1 / 60: Фиксированный шаг времени симуляции (таймстеп) — 1/60 секунды (примерно 16.6 мс). Физика автомобиля и движения рассчитывается строго с этим фиксированным шагом, независимо от текущей частоты кадров (FPS) браузера, чтобы поведение машины было стабильным и предсказуемым на любых компьютерах.
------------------------------------------
-->>Разбор каждой функции из этого файла
1. getTurnSignalFlash
    За что отвечает: Управляет синхронным миганием указателей поворота (поворотников) и индикаторов на приборной панели.
    Как работает: Принимает текущий сигнал (left, right или hazard) и игровое время (simTime). Возвращает объект с флагами: активна ли фаза мигания в данный момент (blinkOn), должен ли гореть левый фонарь (leftLit) и правый (rightLit).
2. clamp
    За что отвечает: Универсальная вспомогательная функция ограничения числа (ограничитель диапазона).
    Как работает: Принимает значение v, а также минимальный (min) и максимальный (max) пороги. Если значение выходит за рамки, оно «прижимается» к границе диапазона.
3. ackermannAngle
    За что отвечает: Вычисляет индивидуальный угол поворота для левого или правого переднего колеса по геометрии Аккермана.
    Как работает: Учитывает, что внутреннее колесо должно поворачиваться на больший угол, чем внешнее, чтобы машина ехала по кругу без бокового проскальзывания шин. На вход принимает сторону (side: +1 или -1) и центральный угол поворота (delta), а на выходе возвращает точный угол для конкретного колеса.
4. wheelDegToSteerRad
    За что отвечает: Переводит текущий угол поворота виртуального руля (в градусах) в центральный угол поворота колёс (в радианах).
    Как работает: Ограничивает угол поворота руля максимальным значением (например, ±540°), делит его на передаточное число рулевого управления (ratio) и переводит результат в радианы с учётом ограничения CAR.maxSteer.
5. outerTurningRadius
    За что отвечает: Рассчитывает радиус поворота автомобиля по его внешнему переднему габариту.
    Как работает: Использует текущий центральный угол поворота (delta), колёсную базу и ширину машины, чтобы определить радиус дуги, по которой движется крайняя точка автомобиля.
6. computeEngineAccel
    За что отвечает: Вычисляет продольное ускорение автомобиля от двигателя в зависимости от текущей передачи и степени нажатия на газ.
    Как работает: Проверяет, заведён ли двигатель, отпущен ли ручник и какая включена передача (включая заднюю R и автоматические ступени D). Возвращает ускорение в м/с² с учётом ограничения максимальной скорости для каждой передачи.
7. getCarCorners
    За что отвечает: Вычисляет мировые координаты четырёх углов кузова автомобиля (Передний-Левый, Передний-Правый, Задний-Правый, Задний-Левый).
    Как работает: Использует текущие координаты центра машины (x, z), угол поворота кузова (h) и габариты (длину, ширину и свесы), что необходимо для точной проверки столкновений.
8. predictTrajectoryArc
    За что отвечает: Строит прогнозную траекторию (дугу) движения передних и задних габаритов автомобиля для режима инструктора.
    Как работает: Просчитывает несколько шагов вперёд на основе текущего угла поворота руля (steer) и направления движения (вперед или назад), возвращая массивы точек для отрисовки траектории на дороге.
9. getTrafficLightPhase
    За что отвечает: Определяет текущую фазу работы светофоров и оставшееся до её смены время.
    Как работает: На основе игрового времени (simTime) и параметров конкретного светофора вычисляет, горит ли в данный момент зелёный, мигающий зелёный, жёлтый или красный сигнал, а также разрешён ли проезд.
10. getPedestrianPose
    За что отвечает: Рассчитывает детерминированную позицию и позу пешехода на нерегулируемом пешеходном переходе.
    Как работает: Учитывает фазу движения, скорость пешехода и паузы на тротуаре, возвращая текущие координаты (x, z), угол поворота (h) и признак того, находится ли пешеход сейчас на проезжей части.
 */
export const CAR = {
  model: "Kia Ceed JD (кат. B)",
  wheelbase: 2.65,
  track: 1.57,
  frontOverhang: 0.88,
  rearOverhang: 0.78,
  length: 2.65 + 0.88 + 0.78, // 4.31 м
  width: 1.8,
  height: 1.447,
  wheelRadius: 0.315,
  wheelWidth: 0.215,
  maxInnerDeg: 40,
  maxSteer: Math.atan(1 / (1 / Math.tan((40 * Math.PI) / 180) + 1.57 / (2 * 2.65))), // ~0.5917 рад (33.9°)
  rollRes: 0.34,
  brakeDecel: 6.2,
  handbrakeDecel: 8.5,
} as const;

// Параметры рулевого управления: ±540° (3 оборота от упора до упора)
export const STEER_WHEEL = {
  maxDeg: 540,
  ratio: 540 / ((CAR.maxSteer * 180) / Math.PI), // ~15.9° руля на 1° колёс
  keyRateDegPerSec: 340,
  selfCenterRate: 220,
} as const;

// Габариты процедурных моделей автопарка (из v8 DIM)
export const VEHICLE_DIMS: Record<
  ParkedModelKey,
  { length: number; width: number; height: number; wheelbase: number; name: string }
> = {
  picanto: { length: 3.595, width: 1.595, height: 1.485, wheelbase: 2.4, name: "Kia Picanto" },
  rio: { length: 4.4, width: 1.74, height: 1.47, wheelbase: 2.6, name: "Kia Rio" },
  ceed: { length: 4.31, width: 1.8, height: 1.447, wheelbase: 2.65, name: "Kia Ceed" },
  xceed: { length: 4.395, width: 1.826, height: 1.495, wheelbase: 2.65, name: "Kia XCeed" },
  sorento: { length: 4.81, width: 1.9, height: 1.695, wheelbase: 2.815, name: "Kia Sorento" },
};

// Пороги переключения 5-ступенчатой АКПП с гистерезисом (км/ч)
export const AUTO_UP = [0, 18, 34, 52, 74, 999] as const;
export const AUTO_DOWN = [0, 0, 12, 26, 43, 62] as const;

export const FIXED_DT = 1 / 60;

/** Shared 700 ms indicator cadence for vehicle lamps and the dashboard. */
export function getTurnSignalFlash(signal: TurnSignal, simTime: number): {
  blinkOn: boolean;
  leftLit: boolean;
  rightLit: boolean;
} {
  const blinkOn = Math.floor((simTime * 1000) / 350) % 2 === 0;
  return {
    blinkOn,
    leftLit: blinkOn && (signal === "left" || signal === "hazard"),
    rightLit: blinkOn && (signal === "right" || signal === "hazard"),
  };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Угол поворота переднего колеса по геометрии Аккермана.
 * side = +1 — левое колесо (+X), side = -1 — правое колесо (-X).
 * delta — центральный угол (рад): > 0 поворот влево, < 0 поворот вправо.
 * При повороте влево (delta > 0) левое колесо (+1) внутреннее => |угол| больше.
 */
export function ackermannAngle(side: 1 | -1, delta: number): number {
  if (Math.abs(delta) < 1e-6) return 0;
  const turnSign = Math.sign(delta); // +1 влево, -1 вправо
  const cotCenter = 1 / Math.tan(Math.abs(delta));
  const halfTrackOverBase = CAR.track / (2 * CAR.wheelbase);
  // Если side === turnSign, колесо внутреннее (cot меньше -> угол больше)
  const cotWheel = side === turnSign ? cotCenter - halfTrackOverBase : cotCenter + halfTrackOverBase;
  return turnSign * Math.atan(1 / Math.max(0.15, cotWheel));
}

/** Перевод угла руля (-540..+540°) в центральный угол передних колёс (рад). */
export function wheelDegToSteerRad(swDeg: number): number {
  const clamped = clamp(swDeg, -STEER_WHEEL.maxDeg, STEER_WHEEL.maxDeg);
  return clamp(((clamped / STEER_WHEEL.ratio) * Math.PI) / 180, -CAR.maxSteer, CAR.maxSteer);
}

/** Радиус поворота по внешнему переднему габариту (м) при данном центральном угле. */
export function outerTurningRadius(delta: number): number {
  const absD = Math.abs(delta);
  if (absD < 0.01) return Infinity;
  const rRearCenter = CAR.wheelbase / Math.tan(absD);
  const rOuterSide = rRearCenter + CAR.width / 2;
  const frontFromRearAxle = CAR.wheelbase + CAR.frontOverhang;
  return Math.hypot(rOuterSide, frontFromRearAxle);
}

/** Продольное ускорение от двигателя (м/с²) в текущей передаче. */
export function computeEngineAccel(
  throttle: number,
  gear: Gear,
  autoSubGear: number,
  v: number,
  engineOn: boolean,
  handbrake: boolean
): number {
  // P (Parking) и N не передают тягу на колёса
  if (!engineOn || handbrake || gear === "N" || gear === "P" || throttle <= 0) return 0;
  const kmh = Math.abs(v) * 3.6;
  if (gear === "R") {
    // Плавный и контролируемый задний ход до ~14 км/ч
    if (v < -14 / 3.6) return 0;
    const factor = clamp(1 - Math.max(0, -v * 3.6) / 15, 0.12, 1);
    return -1.95 * throttle * factor;
  }
  const activeGear = gear === "D" ? autoSubGear : Number(gear);
  const maxSpeedByGear = [0, 22, 40, 62, 85, 115];
  const baseAccelByGear = [0, 2.75, 2.25, 1.85, 1.45, 1.1];
  const cap = maxSpeedByGear[activeGear] ?? 60;
  if (v > 0 && kmh >= cap) return 0;
  const taper = clamp(1 - Math.max(0, kmh) / (cap * 1.12), 0.18, 1);
  return (baseAccelByGear[activeGear] ?? 2.0) * throttle * taper;
}

/** Четыре угла кузова автомобиля в мировых координатах: [FL, FR, RR, RL]. */
export function getCarCorners(x: number, z: number, h: number): [Vec2, Vec2, Vec2, Vec2] {
  // x, z — середина колёсной базы. Смещение геометрического центра кузова вперёд:
  const centerShiftZ = (CAR.frontOverhang - CAR.rearOverhang) / 2; // +0.05 м
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const lx = Math.cos(h);
  const lz = -Math.sin(h);

  const halfL = CAR.length / 2;
  const halfW = CAR.width / 2;
  const bodyX = x + fx * centerShiftZ;
  const bodyZ = z + fz * centerShiftZ;

  return [
    { x: bodyX + fx * halfL + lx * halfW, z: bodyZ + fz * halfL + lz * halfW }, // FL (+Z, +X)
    { x: bodyX + fx * halfL - lx * halfW, z: bodyZ + fz * halfL - lz * halfW }, // FR (+Z, -X)
    { x: bodyX - fx * halfL - lx * halfW, z: bodyZ - fz * halfL - lz * halfW }, // RR (-Z, -X)
    { x: bodyX - fx * halfL + lx * halfW, z: bodyZ - fz * halfL + lz * halfW }, // RL (-Z, +X)
  ];
}

/** Прогнозная траектория передних/задних габаритов для режима инструктора (м). */
export function predictTrajectoryArc(
  x: number,
  z: number,
  h: number,
  steer: number,
  reverse: boolean,
  distance = 6.5,
  steps = 18
): { leftTrack: Vec2[]; rightTrack: Vec2[] } {
  const leftTrack: Vec2[] = [];
  const rightTrack: Vec2[] = [];
  const dir = reverse ? -1 : 1;
  const ds = (distance / steps) * dir;
  let cx = x;
  let cz = z;
  let ch = h;
  const halfW = CAR.width / 2;
  const zLocal = reverse ? -(CAR.wheelbase / 2 + CAR.rearOverhang) : CAR.wheelbase / 2 + CAR.frontOverhang;

  for (let i = 0; i <= steps; i++) {
    const fx = Math.sin(ch);
    const fz = Math.cos(ch);
    const lx = Math.cos(ch);
    const lz = -Math.sin(ch);
    leftTrack.push({
      x: cx + fx * zLocal + lx * halfW,
      z: cz + fz * zLocal + lz * halfW,
    });
    rightTrack.push({
      x: cx + fx * zLocal - lx * halfW,
      z: cz + fz * zLocal - lz * halfW,
    });
    cx += Math.sin(ch) * ds;
    cz += Math.cos(ch) * ds;
    ch += (ds / CAR.wheelbase) * Math.tan(steer);
  }
  return { leftTrack, rightTrack };
}

/** Детерминированный расчёт фазы светофора от модельного времени (с). */
export function getTrafficLightPhase(
  sig: TrafficSignalDef,
  simTime: number
): { phase: TrafficLightPhase; remainingSec: number; isForbidden: boolean } {
  const blinkDur = 3;
  const yellowDur = 2.5;
  const redYellowDur = 1.5;
  const total = sig.greenDuration + blinkDur + yellowDur + sig.redDuration + redYellowDur;
  const t = ((simTime + sig.cycleOffset) % total + total) % total;

  if (t < sig.greenDuration) {
    return { phase: "green", remainingSec: sig.greenDuration + blinkDur - t, isForbidden: false };
  }
  const t1 = t - sig.greenDuration;
  if (t1 < blinkDur) {
    return { phase: "green_blink", remainingSec: blinkDur - t1, isForbidden: false };
  }
  const t2 = t1 - blinkDur;
  if (t2 < yellowDur) {
    return { phase: "yellow", remainingSec: yellowDur - t2, isForbidden: true };
  }
  const t3 = t2 - yellowDur;
  if (t3 < sig.redDuration) {
    return { phase: "red", remainingSec: sig.redDuration - t3, isForbidden: true };
  }
  const t4 = t3 - sig.redDuration;
  return { phase: "red_yellow", remainingSec: redYellowDur - t4, isForbidden: true };
}

/** Детерминированная позиция пешехода на нерегулируемом переходе. */
export function getPedestrianPose(cw: CrosswalkDef, simTime: number): PedestrianPose {
  const sideMargin = 2.4;
  const span = cw.width + sideMargin * 2;
  const crossTime = span / cw.pedSpeed;
  const pauseTime = 5.5;
  const halfCycle = crossTime + pauseTime;
  const fullCycle = halfCycle * 2;
  const t = ((simTime + cw.pedPhaseOffset) % fullCycle + fullCycle) % fullCycle;

  const goingRight = t < halfCycle;
  const localT = goingRight ? t : t - halfCycle;
  const progress = clamp(localT / crossTime, 0, 1);
  // localX от +span/2 (левый тротуар) к -span/2 (правый тротуар) и обратно
  const localX = goingRight ? span / 2 - progress * span : -span / 2 + progress * span;
  const lx = Math.cos(cw.h);
  const lz = -Math.sin(cw.h);
  const onRoadway = Math.abs(localX) <= cw.width / 2 + 0.35 && localT < crossTime;

  return {
    crosswalkId: cw.id,
    x: cw.cx + lx * localX,
    z: cw.cz + lz * localX,
    h: goingRight ? cw.h - Math.PI / 2 : cw.h + Math.PI / 2,
    onRoadway,
    walkPhase: localT < crossTime ? simTime * 6.5 : 0,
  };
}
