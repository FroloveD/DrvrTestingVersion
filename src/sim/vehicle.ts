/**
 * @module sim/vehicle
 * @layer pure-core
 * @role Паспорт Kia Ceed JD, геометрия Аккермана, калибровка выворота 33–42°, тяга АКПП, фазы светофора и пешехода.
 * @invariants #1 (координаты), #2 (цикл поворотников 700 мс), #6 (FIXED_DT = 1/60), #7 (чистое ядро),
 *             #10 (руль ±540°, выворот 33–42°, базовый 35° побитно совместим со старыми записями).
 * @tests T01, T02, T12, T13, T23, T24
 *
 * Справочник констант модуля:
 * 1. `CAR` — физический и геометрический паспорт учебного Kia Ceed JD (кат. B):
 *    - `wheelbase` (2,65 м) — база между передней и задней осями; `track` (1,57 м) — колея;
 *    - `frontOverhang` (0,88 м), `rearOverhang` (0,78 м) — свесы; `length` (4,31 м), `width` (1,80 м), `height` (1,447 м);
 *    - `wheelRadius` (0,315 м), `wheelWidth` (0,215 м) — размеры шины;
 *    - `maxInnerDeg` (35°) — базовый предел внутреннего колеса; `maxSteer` (≈ 0,5256 рад / 30,11°) — базовый
 *      центральный угол велосипедной модели (внешнее колесо при нём ≈ 26,2°);
 *    - `rollRes` (0,34 м/с²), `brakeDecel` (6,2 м/с²), `handbrakeDecel` (8,5 м/с²) — замедления.
 * 2. `STEER_WHEEL` — виртуальный руль: ход `±540°` (3 оборота от упора до упора), базовое передаточное число
 *    `ratio ≈ 17,93`, скорость с клавиатуры `keyRateDegPerSec = 340°/с`, самовозврат `selfCenterRate = 220°/с`.
 * 3. `WHEEL_LOCK` — калибровка предела внутреннего колеса `33..42°` с шагом `0,5°` (по умолчанию `35°`).
 * 4. `VEHICLE_DIMS` — габариты процедурного автопарка (Kia Picanto, Rio, Ceed, XCeed, Sorento) для боксов.
 * 5. `AUTO_UP` / `AUTO_DOWN` — скоростные пороги (км/ч) 5-ступенчатой АКПП с гистерезисом.
 * 6. `FIXED_DT = 1 / 60` — фиксированный шаг симуляции (≈ 16,67 мс), обеспечивающий детерминизм при любом FPS.
 *
 * Справочник функций модуля:
 * - `getTurnSignalFlash` — синхронное мигание поворотников и индикаторов приборки (период 700 мс от `simTime`).
 * - `clamp` — ограничение числа диапазоном `[min, max]`.
 * - `ackermannAngle` — угол левого (`+1`) или правого (`-1`) переднего колеса по геометрии Аккермана.
 * - `normalizeWheelLock` / `centralSteerLimit` / `wheelDegToSteerRad` — безопасная нормализация предела выворота
 *   и перевод угла руля `[-540°, +540°]` в центральный угол колёс (при `35°` формула побитно идентична старым реплеям).
 * - `outerTurningRadius` — радиус поворота по внешнему переднему габариту кузова (м).
 * - `computeEngineAccel` — продольное ускорение от ДВС (м/с²) с учётом передачи (`P`/`N` = 0, `R` до ~14 км/ч, `D1..D5`).
 * - `getCarCorners` — мировые координаты 4 углов кузова `[FL, FR, RR, RL]` с учётом смещения свесов.
 * - `predictTrajectoryArc` — прогнозная дуга габаритов (м) для подсказки в режиме инструктора.
 * - `getTrafficLightPhase` / `getPedestrianPose` — детерминированные функции `simTime` для светофоров и пешеходов.
 */
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
import { getPlayerCar } from "./playerCar";

// Параметры автомобиля игрока Kia Ceed JD (DEV_PROMPTS, п. 2.1):
// база L = 2.65 м, свес передний 0.88 м, задний 0.78 м (общая длина 4.31 м),
// ширина 1.80 м, высота 1.447 м, колея T = 1.57 м.
// Внутреннее колесо до 35°, центральный угол maxSteer ≈ 30.11°, внешнее ≈ 26.2°.
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
  maxInnerDeg: 35,
  maxSteer: Math.atan(1 / (1 / Math.tan((35 * Math.PI) / 180) + 1.57 / (2 * 2.65))), // ~0.5256 рад (30.11°)
  rollRes: 0.34,
  brakeDecel: 6.2,
  handbrakeDecel: 8.5,
} as const;

// Параметры рулевого управления: ±540° (3 оборота от упора до упора)
export const STEER_WHEEL = {
  maxDeg: 540,
  ratio: 540 / ((CAR.maxSteer * 180) / Math.PI), // ~17.93° руля на 1° колёс
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
export const MAX_FORWARD_GEAR = 6;
export const MAX_SPEED_KMH = 180;
export const MAX_SPEED_MS = MAX_SPEED_KMH / 3.6;
export const MAX_REVERSE_KMH = 14;
export const ENGINE_IDLE_RPM = 800;
export const ENGINE_REDLINE_RPM = 6500;
export const ENGINE_REV_LIMIT_RPM = 6450;
export const SHIFT_HINT_RPM = 5500;
export const GEAR_MAX_KMH = [0, 48, 84, 122, 154, 175, MAX_SPEED_KMH] as const;
export const GEAR_RPM_PER_KMH = [0, 133, 76, 52.5, 41.6, 35.4, 29.0] as const;
export const GEAR_PEAK_ACCEL = [0, 4.08, 3.04, 2.32, 1.88, 1.62, 1.48] as const;
export const AUTO_UP = [0, 21, 38, 56, 76, 102, 999] as const;
export const AUTO_UP_SPORT = [0, 45.5, 80.5, 117.5, 149, 170.5, 999] as const;
export const AUTO_DOWN = [0, 0, 13, 27, 43, 60, 80] as const;
export const AUTO_DOWN_KICK = [0, 0, 36, 68, 102, 132, 154] as const;
export const MANUAL_STALL_DOWN_KMH = [0, 0, 7, 15, 25, 36, 48] as const;
export const AUTO_SHIFT_DURATION_S = 0.24;
export const MANUAL_SHIFT_DURATION_S = 0.18;
export const IDLE_CREEP_MAX_KMH = 5;
export const BRAKE_BUILD_UP_TAU_S = 0.34;
export const BRAKE_RELEASE_TAU_S = 0.13;
export const SERVICE_BRAKE_MAX_DECEL = 8.4;

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
export type CarGeometry = {
  length: number; width: number; wheelbase: number; frontOverhang: number;
  rearOverhang: number; wheelRadius: number; track: number;
};
const BASE_GEOMETRY: CarGeometry = {
  length: CAR.length, width: CAR.width, wheelbase: CAR.wheelbase,
  frontOverhang: CAR.frontOverhang, rearOverhang: CAR.rearOverhang,
  wheelRadius: CAR.wheelRadius, track: CAR.track,
};
export function carGeometry(carId?: string | null): CarGeometry {
  const c = getPlayerCar(carId);
  return { length:c.length, width:c.width, wheelbase:c.wheelbase, frontOverhang:c.frontOverhang,
    rearOverhang:c.rearOverhang, wheelRadius:c.wheelRadius, track:c.track };
}
export function carGeometryFor(carId?: string | null): CarGeometry {
  return carId ? carGeometry(carId) : BASE_GEOMETRY;
}
export function ackermannAngle(side: 1 | -1, delta: number, geo: CarGeometry = BASE_GEOMETRY): number {
  if (Math.abs(delta) < 1e-6) return 0;
  const turnSign = Math.sign(delta);
  const cotCenter = 1 / Math.tan(Math.abs(delta));
  const halfTrackOverBase = geo.track / (2 * geo.wheelbase);
  const cotWheel = side === turnSign ? cotCenter - halfTrackOverBase : cotCenter + halfTrackOverBase;
  return turnSign * Math.atan(1 / Math.max(0.15, cotWheel));
}

export const WHEEL_LOCK = { min: 33, max: 42, defaultDeg: CAR.maxInnerDeg, step: 0.5 } as const;

/** В том числе для старых записей и повреждённых настроек из хранилища. */
export function normalizeWheelLock(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, WHEEL_LOCK.min, WHEEL_LOCK.max)
    : WHEEL_LOCK.defaultDeg;
}

/** Из предела внутреннего колеса получаем предельный угол велосипедной модели. */
export function centralSteerLimit(innerWheelDeg?: number, geo: CarGeometry = BASE_GEOMETRY): number {
  const inner = normalizeWheelLock(innerWheelDeg);
  if (inner === WHEEL_LOCK.defaultDeg && geo.track === CAR.track && geo.wheelbase === CAR.wheelbase) return CAR.maxSteer;
  const cotInner = 1 / Math.tan((inner * Math.PI) / 180);
  return Math.atan(1 / (cotInner + geo.track / (2 * geo.wheelbase)));
}

/** Ход руля всегда ±540°. Предел колёс не меняет скорость вращения руля или габариты автомобиля. */
export function wheelDegToSteerRad(swDeg: number, innerWheelDeg?: number, geo: CarGeometry = BASE_GEOMETRY): number {
  const limit = centralSteerLimit(innerWheelDeg, geo);
  const ratio = STEER_WHEEL.maxDeg / ((limit * 180) / Math.PI);
  const clamped = clamp(swDeg, -STEER_WHEEL.maxDeg, STEER_WHEEL.maxDeg);
  // Сохраняем порядок операций v0.3: старые реплеи при 35° совпадают побитно.
  return clamp(((clamped / ratio) * Math.PI) / 180, -limit, limit);
}

/** Радиус поворота по внешнему переднему габариту (м) при данном центральном угле. */
export function outerTurningRadius(delta: number, geo: CarGeometry = BASE_GEOMETRY): number {
  const absD = Math.abs(delta);
  if (absD < 0.01) return Infinity;
  const rRearCenter = geo.wheelbase / Math.tan(absD);
  const rOuterSide = rRearCenter + geo.width / 2;
  const frontFromRearAxle = geo.wheelbase + geo.frontOverhang;
  return Math.hypot(rOuterSide, frontFromRearAxle);
}

/** Продольное ускорение от двигателя (м/с²) в текущей передаче. */
export function isManualGear(gear: Gear): gear is "1" | "2" | "3" | "4" | "5" | "6" {
  return gear === "1" || gear === "2" || gear === "3" || gear === "4" || gear === "5" || gear === "6";
}
export function formatGearLabel(gear: Gear, autoSubGear: number, engineOn: boolean): string {
  if (gear === "D") return engineOn ? `D${clamp(Math.round(autoSubGear || 1), 1, MAX_FORWARD_GEAR)}` : "D";
  if (isManualGear(gear)) return `M${gear}`;
  return gear;
}
export function engineTorqueFactor(rpm: number): number {
  if (rpm <= 1200) return 0.72 + 0.1 * clamp((rpm - ENGINE_IDLE_RPM) / 400, 0, 1);
  if (rpm <= 2800) return 0.82 + 0.11 * ((rpm - 1200) / 1600);
  if (rpm <= 4850) return 0.93 + 0.07 * ((rpm - 2800) / 2050);
  if (rpm <= 6250) return 1 - 0.1 * ((rpm - 4850) / 1400);
  if (rpm <= ENGINE_REV_LIMIT_RPM + 80) return 0.9 * clamp(1 - (rpm - 6250) / 260, 0, 1);
  return 0;
}
export const ENGINE_BRAKE_GEAR_RATIO = [0, 5.6, 3.1, 1.95, 1.4, 1.08, 0.86] as const;
export function computeRoadDragDecel(absV:number, throttlePos=0, activeForwardGear=0, gear:Gear="D", engineOn=true, carAccelScale=1):number {
  const aeroAndRoll = 0.148 + 0.000331 * absV * absV + 0.0029 * absV;
  if (gear === "N") return aeroAndRoll;
  const coast = Math.pow(clamp(1-throttlePos,0,1),1.3);
  const lowSpeedRollSettle = 0.095 * (1-clamp(absV/0.72,0,1));
  if (gear === "R") return 0.24 + 0.018*absV + coast*(0.36+0.055*absV+lowSpeedRollSettle);
  if (activeForwardGear>=1 && activeForwardGear<=MAX_FORWARD_GEAR) {
    if(!engineOn) return aeroAndRoll+0.22+lowSpeedRollSettle;
    const kmh=absV*3.6, wheelRpm=kmh*GEAR_RPM_PER_KMH[activeForwardGear];
    const gearLoss=(0.16+0.19*ENGINE_BRAKE_GEAR_RATIO[activeForwardGear])*clamp(carAccelScale,0.7,1.35);
    const rpmFactor=0.58+0.82*clamp((wheelRpm-1050)/3600,0,1);
    const dfcoFade=activeForwardGear===1?clamp((kmh-IDLE_CREEP_MAX_KMH)/6.5,0,1):clamp((kmh-3.5)/6,0,1);
    return aeroAndRoll+coast*gearLoss*rpmFactor*dfcoFade;
  }
  return aeroAndRoll+coast*(0.045+lowSpeedRollSettle);
}
export function computeServiceBrakeDecel(brakePos:number,absV:number,shiftBoost=0,brakeScale=1):number {
  const b=clamp(brakePos,0,1); if(b<=0.001)return 0;
  const kmh=absV*3.6, pedalCurve=0.06+0.94*Math.pow(b,1.9);
  const highSpeedFactor=1-0.06*clamp((kmh-90)/90,0,1);
  const finalStopSettle=0.58+0.42*clamp(absV/0.6,0,1);
  const boost=1+0.18*clamp(shiftBoost,0,1);
  return SERVICE_BRAKE_MAX_DECEL*pedalCurve*highSpeedFactor*finalStopSettle*boost*clamp(brakeScale,0.75,1.4);
}
export function computeIdleCreepAccel(gear:Gear,autoSubGear:number,v:number,throttlePos:number,brakePos:number,engineOn:boolean,handbrake:boolean,creepKmh=IDLE_CREEP_MAX_KMH):number {
  if(!engineOn||handbrake)return 0;
  const first=(gear==="D"&&autoSubGear===1)||gear==="1"; if(!first||v<-.05)return 0;
  const brakeRelease=clamp(1-brakePos/0.16,0,1); if(brakeRelease<=0)return 0;
  const throttleHandoff=1-clamp(throttlePos*2.6,0,1); if(throttleHandoff<=0)return 0;
  const fwdKmh=Math.max(0,v*3.6), target=clamp(creepKmh,3.5,7); if(fwdKmh>=target)return 0;
  const reserve=Math.pow(1-fwdKmh/target,0.62), base=0.153+(target-5)*0.022;
  return brakeRelease*throttleHandoff*(base+0.09*reserve);
}
function smoothSlewRpm(rpm:number,target:number,rate:number,maxSlewPerSec:number,dt:number):number {
  const expDelta=(target-rpm)*Math.min(1,dt*rate), maxStep=maxSlewPerSec*dt;
  return rpm+clamp(expDelta,-maxStep,maxStep);
}
export function stepEngineRpm(prevRpm:number,throttlePos:number,gear:Gear,autoSubGear:number,v:number,engineOn:boolean,shiftTimer:number,dt:number,brakePos=0,handbrake=false):number {
  if(!engineOn){const n=smoothSlewRpm(prevRpm,0,4.6,3600,dt);return n<8?0:n;}
  const th=clamp(throttlePos,0,1);
  if(gear==="P"||gear==="N"){
    const target=clamp(ENGINE_IDLE_RPM+Math.pow(th,0.92)*(ENGINE_REV_LIMIT_RPM-ENGINE_IDLE_RPM),ENGINE_IDLE_RPM,ENGINE_REV_LIMIT_RPM);
    const rising=target>prevRpm;
    return clamp(smoothSlewRpm(prevRpm,target,rising?4.2:8,rising?5400:7000,dt),0,ENGINE_REDLINE_RPM);
  }
  const kmh=Math.abs(v)*3.6, held=kmh<0.35&&th<0.02&&(brakePos>0.16||handbrake), idle=held?ENGINE_IDLE_RPM-35:ENGINE_IDLE_RPM;
  if(gear==="R"){
    const target=clamp(idle+kmh*118+th*780,idle,3600), rising=target>prevRpm;
    return clamp(smoothSlewRpm(prevRpm,target,rising?4.8:5.2,rising?3800:4200,dt),0,ENGINE_REDLINE_RPM);
  }
  const active=clamp(gear==="D"?autoSubGear:Number(gear)||1,1,MAX_FORWARD_GEAR);
  const coupled=kmh*GEAR_RPM_PER_KMH[active], lock=clamp((coupled-700)/1700,0,1);
  const target=clamp(Math.max(idle,coupled+th*1050*(1-lock*0.92)*(shiftTimer>0?0.2:1)),idle,ENGINE_REV_LIMIT_RPM);
  const rising=target>prevRpm, rate=shiftTimer>0?7.2:rising?5.6:6, slew=shiftTimer>0?7800:rising?5000:6200;
  return clamp(smoothSlewRpm(prevRpm,target,rate,slew,dt),0,ENGINE_REDLINE_RPM);
}
export function computeEngineAccel(throttle:number,gear:Gear,autoSubGear:number,v:number,engineOn:boolean,handbrake:boolean,shiftTimer=0,accelScale=1,vmaxKmh=MAX_SPEED_KMH):number {
  if(!engineOn||handbrake||gear==="N"||gear==="P"||throttle<=0)return 0;
  const th=clamp(throttle,0,1);
  if(gear==="R"){
    const kmh=Math.max(0,-v*3.6); if(kmh>=MAX_REVERSE_KMH)return 0;
    return -2.45*Math.pow(th,0.65)*clamp(1-kmh/(MAX_REVERSE_KMH+1.2),0.14,1);
  }
  const active=clamp(gear==="D"?autoSubGear:Number(gear)||1,1,MAX_FORWARD_GEAR), fwdKmh=Math.max(0,v*3.6);
  const maxSpeed=clamp(vmaxKmh,130,230), speedScale=maxSpeed/MAX_SPEED_KMH;
  if(fwdKmh>=maxSpeed)return 0;
  const cap=GEAR_MAX_KMH[active]*speedScale; let limit=1;
  if(active<MAX_FORWARD_GEAR){if(fwdKmh>=cap)return 0;if(fwdKmh>cap-1.2)limit=(cap-fwdKmh)/1.2;}
  if(fwdKmh>maxSpeed-0.8)limit=Math.min(limit,0.78+0.22*((maxSpeed-fwdKmh)/0.8));
  const wheelRpm=fwdKmh*GEAR_RPM_PER_KMH[active], lock=clamp((wheelRpm-700)/1700,0,1);
  const effRpm=Math.max(ENGINE_IDLE_RPM,wheelRpm+th*1050*(1-lock*0.92)), torque=engineTorqueFactor(effRpm);
  const launch=active===1?1+0.1*(1-clamp(fwdKmh/18,0,1)):1;
  return th*GEAR_PEAK_ACCEL[active]*clamp(accelScale,0.7,1.35)*torque*launch*(shiftTimer>0?0.14:1)*limit;
}
/** Четыре угла кузова автомобиля в мировых координатах: [FL, FR, RR, RL]. */
export function getCarCorners(x: number, z: number, h: number, geo: CarGeometry = BASE_GEOMETRY): [Vec2, Vec2, Vec2, Vec2] {
  // x, z — середина колёсной базы. Смещение геометрического центра кузова вперёд:
  const centerShiftZ = (geo.frontOverhang - geo.rearOverhang) / 2;
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const lx = Math.cos(h);
  const lz = -Math.sin(h);

  const halfL = geo.length / 2;
  const halfW = geo.width / 2;
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
  steps = 18,
  geo: CarGeometry = BASE_GEOMETRY
): { leftTrack: Vec2[]; rightTrack: Vec2[] } {
  const leftTrack: Vec2[] = [];
  const rightTrack: Vec2[] = [];
  const dir = reverse ? -1 : 1;
  const ds = (distance / steps) * dir;
  let cx = x;
  let cz = z;
  let ch = h;
  const halfW = geo.width / 2;
  const zLocal = reverse ? -(geo.wheelbase / 2 + geo.rearOverhang) : geo.wheelbase / 2 + geo.frontOverhang;

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
    ch += (ds / geo.wheelbase) * Math.tan(steer);
  }
  return { leftTrack, rightTrack };
}

/**
 * Записывает прогнозную траекторию в заранее выделенные XYZ-буферы.
 * Не создаёт массивов и объектов точек; предназначено для горячего пути 3D-рендера.
 * Порядок точек и формулы совпадают с predictTrajectoryArc().
 */
export function writeTrajectoryArcPositions(
  x: number,
  z: number,
  h: number,
  steer: number,
  reverse: boolean,
  leftPositions: Float32Array,
  rightPositions: Float32Array,
  distance = 6.5,
  steps = 18,
  y = 0.06,
  geo: CarGeometry = BASE_GEOMETRY
): void {
  const requiredLength = (steps + 1) * 3;
  if (!Number.isInteger(steps) || steps < 1 || leftPositions.length < requiredLength || rightPositions.length < requiredLength) {
    throw new RangeError("Недостаточная длина буфера траектории Аккермана");
  }

  const dir = reverse ? -1 : 1;
  const ds = (distance / steps) * dir;
  let cx = x;
  let cz = z;
  let ch = h;
  const halfW = geo.width / 2;
  const zLocal = reverse ? -(geo.wheelbase / 2 + geo.rearOverhang) : geo.wheelbase / 2 + geo.frontOverhang;

  for (let i = 0; i <= steps; i++) {
    const fx = Math.sin(ch);
    const fz = Math.cos(ch);
    const lx = Math.cos(ch);
    const lz = -Math.sin(ch);
    const offset = i * 3;

    leftPositions[offset] = cx + fx * zLocal + lx * halfW;
    leftPositions[offset + 1] = y;
    leftPositions[offset + 2] = cz + fz * zLocal + lz * halfW;
    rightPositions[offset] = cx + fx * zLocal - lx * halfW;
    rightPositions[offset + 1] = y;
    rightPositions[offset + 2] = cz + fz * zLocal - lz * halfW;

    cx += Math.sin(ch) * ds;
    cz += Math.cos(ch) * ds;
    ch += (ds / geo.wheelbase) * Math.tan(steer);
  }
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
