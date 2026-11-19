/**
 * @module sim/step
 * @layer pure-core
 * @role Единственный чистый шаг физики автомобиля и детекторов экзаменационных событий (`stepSimulation`, `dt = 1/60` с).
 * @invariants #1–#7, #10–#11, #15 (детерминизм, холодный старт P, S не даёт реверс в D, аварийка не заменяет Q/E на старте).
 * @tests T01, T03, T04, T08, T10, T15, T22, T24, T25
 */
import { clampCarToWorldBoundary, isValidBoundaryPolygon } from "../maps/boundary";
import type { RuleSet } from "../scoring/rules";
import { findBayLineCross, findBayUnderCarCenter, findCompletedBay, SpatialGrid } from "./spatialGrid";
import type {
  CalibrationConfig,
  InputState,
  SimEvent,
  SimEventCode,
  SimState,
  WorldData,
} from "./types";
import {
  ackermannAngle,
  AUTO_DOWN,
  AUTO_DOWN_KICK,
  AUTO_SHIFT_DURATION_S,
  AUTO_UP,
  AUTO_UP_SPORT,
  CAR,
  clamp,
  computeEngineAccel,
  computeRoadDragDecel,
  ENGINE_IDLE_RPM,
  FIXED_DT,
  getPedestrianPose,
  getTrafficLightPhase,
  isManualGear,
  MANUAL_SHIFT_DURATION_S,
  MAX_FORWARD_GEAR,
  MAX_REVERSE_KMH,
  MAX_SPEED_MS,
  stepEngineRpm,
  wheelDegToSteerRad,
  normalizeWheelLock,
} from "./vehicle";

/** Холодный старт: двигатель заглушен, селектор АКПП в P (Parking), ручник затянут. */
export function createInitialInput(): InputState {
  return {
    throttle: 0,
    brake: 0,
    steerWheelDeg: 0,
    gear: "P",
    engineOn: false,
    handbrake: true,
    belt: false,
    lights: false,
    signal: null,
  };
}

/** Удобный пресет «Готов к старту» (двигатель заведён, ремень пристёгнут, ручник снят, фары включены). */
export function createReadyInput(gear: InputState["gear"] = "R"): InputState {
  return {
    throttle: 0,
    brake: 0,
    steerWheelDeg: 0,
    gear,
    engineOn: true,
    handbrake: false,
    belt: true,
    lights: true,
    signal: null,
  };
}

const OBSTACLE_HIT_LABELS: Record<string, string> = {
  parked_car: "припаркованный автомобиль",
  curb: "бордюр",
  cone: "разметочный конус",
  pole: "опора/столб",
  building: "здание",
  fence: "ограждение",
  tree: "дерево",
  island: "островок безопасности",
};

/** Маршрутный сценарий (есть контрольные точки) стартует в D, парковочный — в R. */
export function defaultGearForWorld(world: WorldData): "D" | "R" {
  return world.checkpoints.length > 0 || world.scenarioId === "city_osm" ? "D" : "R";
}

export function createInitialState(world: WorldData, readyStart = false, innerLimitDeg?: number): SimState {
  const defaultGear = defaultGearForWorld(world);
  return {
    tick: 0,
    time: 0,
    x: world.start.x,
    z: world.start.z,
    h: world.start.h,
    v: 0,
    prevV: 0,
    maxInnerWheelDeg: normalizeWheelLock(innerLimitDeg),
    steer: 0,
    steerLeft: 0,
    steerRight: 0,
    swDeg: 0,
    gear: readyStart ? defaultGear : "P",
    prevGear: readyStart ? defaultGear : "P",
    autoSubGear: 1,
    rpm: readyStart ? ENGINE_IDLE_RPM : 0,
    throttlePos: 0,
    shiftTimer: 0,
    engineOn: readyStart,
    handbrake: !readyStart,
    belt: readyStart,
    lights: readyStart,
    signal: null,
    wheelSpin: 0,
    pitch: 0,
    roll: 0,
    collisions: 0,
    inContact: false,
    inLineCross: false,
    activeBayId: null,
    holdTime: 0,
    reverseCount: 0,
    hasMoved: false,
    movedWithoutBeltFlagged: false,
    movedWithoutSignalFlagged: false,
    extraReverseFlagged: false,
    speedingCooldown: 0,
    pedestrianCooldown: 0,
    redLightPassedIds: [],
    completedCheckpointIds: [],
    currentCheckpointIndex: 0,
    finished: false,
    finishedReason: null,
    finishedBayId: null,
    neutralSecuredAfterFinish: false,
    distanceTraveled: 0,
    statusText: readyStart
      ? world.examinerBrief
      : "Двигатель заглушен, КПП — P (Parking). Нажмите I, пристегните ремень (B), выберите R или F (D), снимите ручник (Space).",
  };
}

export function getActiveSpeedLimit(x: number, z: number, world: WorldData): number {
  let limit = world.defaultSpeedLimitKmh;
  for (const zone of world.speedZones) {
    if (Math.hypot(x - zone.x, z - zone.z) <= zone.radius) {
      limit = Math.min(limit, zone.limitKmh);
    }
  }
  return limit;
}

export type StepOutput = {
  state: SimState;
  newEvents: SimEvent[];
  gridChecks: number;
  activeSpeedLimitKmh: number;
};

/**
 * Чистый детерминированный шаг симуляции (по умолчанию dt = 1/60 с).
 * Не мутирует входной state и не обращается к глобальным объектам, DOM или Three.js.
 */
export function stepSimulation(
  prev: SimState,
  input: InputState,
  world: WorldData,
  grid: SpatialGrid,
  calibration: CalibrationConfig,
  ruleSet: RuleSet,
  dt: number = FIXED_DT
): StepOutput {
  const s: SimState = {
    ...prev,
    redLightPassedIds: prev.redLightPassedIds,
    completedCheckpointIds: prev.completedCheckpointIds,
  };
  const newEvents: SimEvent[] = [];

  const emit = (code: SimEventCode, detail: string) => {
    newEvents.push({
      id: `${code}-${s.tick}-${newEvents.length}`,
      code,
      tick: s.tick,
      time: Number(s.time.toFixed(2)),
      x: Number(s.x.toFixed(2)),
      z: Number(s.z.toFixed(2)),
      h: Number(s.h.toFixed(3)),
      speedKmh: Number((Math.abs(s.v) * 3.6).toFixed(1)),
      detail,
    });
    if (ruleSet.stopOnImmediateFail) {
      const rule = ruleSet.rules.find((r) => r.code === code && r.enabled);
      if (rule && rule.kind === "immediate" && !s.finished) {
        s.finished = true;
        s.finishedReason = "immediate_fail";
        s.v = 0;
      }
    }
  };

  s.tick += 1;
  s.time += dt;
  s.speedingCooldown = Math.max(0, s.speedingCooldown - dt);
  s.pedestrianCooldown = Math.max(0, s.pedestrianCooldown - dt);

  // Синхронизируем органы управления из InputState
  s.prevGear = s.gear;
  s.gear = input.gear;
  s.engineOn = input.engineOn;
  s.handbrake = input.handbrake;
  s.belt = input.belt;
  s.lights = input.lights;
  s.signal = input.signal;

  // Парковочная блокировка P: удерживает автомобиль даже при нажатом газе
  if (s.gear === "P") {
    const parkDecel = 12 * dt;
    if (Math.abs(s.v) <= parkDecel) s.v = 0;
    else s.v -= Math.sign(s.v) * parkDecel;
  }

  s.swDeg = clamp(input.steerWheelDeg, -540, 540);
  s.maxInnerWheelDeg = normalizeWheelLock(calibration.maxInnerWheelDeg);
  s.steer = wheelDegToSteerRad(s.swDeg, s.maxInnerWheelDeg);
  s.steerLeft = ackermannAngle(1, s.steer);
  s.steerRight = ackermannAngle(-1, s.steer);

  // Если экзамен прекращён мгновенно в строгом режиме — машина остановлена
  if (s.finished && s.finishedReason === "immediate_fail") {
    s.v = 0;
    s.throttlePos = 0;
    s.shiftTimer = 0;
    s.rpm = s.engineOn ? ENGINE_IDLE_RPM : 0;
    s.statusText = "Экзамен прекращён: допущена критическая ошибка (5 баллов). Откройте «Разбор и Реплей».";
    return {
      state: s,
      newEvents,
      gridChecks: 0,
      activeSpeedLimitKmh: getActiveSpeedLimit(s.x, s.z, world),
    };
  }

  // Подсчёт повторных включений передачи заднего хода при парковке
  // (только упражнения без контрольных точек: бокс 90°, параллельная, свой паркинг)
  const isParkingExercise = world.checkpoints.length === 0;
  if (s.gear === "R" && s.prevGear !== "R" && s.hasMoved && !s.finished) {
    s.reverseCount += 1;
    if (
      isParkingExercise &&
      s.reverseCount > 1 &&
      !s.extraReverseFlagged
    ) {
      s.extraReverseFlagged = true;
      emit("extra_reverse", `Повторное включение R (включение №${s.reverseCount}) до завершения парковки`);
    }
  } else if (s.gear === "R" && s.reverseCount === 0 && input.throttle > 0.1 && s.engineOn && !s.handbrake) {
    s.reverseCount = 1;
  }

  // Плавная электронная дроссельная заслонка Kefico ETC (~0,1 с) и пауза переключения 6-ст. КПП
  const throttleCmd = s.engineOn ? clamp(input.throttle, 0, 1) : 0;
  const brake = clamp(input.brake, 0, 1);
  const thRate = throttleCmd > s.throttlePos ? 10.5 : 8.5;
  s.throttlePos = clamp(
    s.throttlePos + (throttleCmd - s.throttlePos) * Math.min(1, dt * thRate),
    0,
    1
  );
  if (s.throttlePos < 0.001 && throttleCmd === 0) s.throttlePos = 0;

  if (s.shiftTimer > 0) {
    s.shiftTimer = Math.max(0, s.shiftTimer - dt);
  }

  // Ручное переключение (Shift: M1..M6) и адаптивный 6-ступенчатый автомат (D1..D6)
  if (isManualGear(s.gear)) {
    const manualNum = Number(s.gear);
    if (isManualGear(s.prevGear) && s.prevGear !== s.gear) {
      s.shiftTimer = MANUAL_SHIFT_DURATION_S;
    } else if (s.prevGear === "D" && s.autoSubGear !== manualNum) {
      s.shiftTimer = MANUAL_SHIFT_DURATION_S;
    }
    s.autoSubGear = manualNum;
  } else if (s.gear === "D") {
    const fwdKmh = Math.max(0, s.v * 3.6);
    const sport = clamp((s.throttlePos - 0.35) / 0.55, 0, 1);
    const upKmh = AUTO_UP[s.autoSubGear] + (AUTO_UP_SPORT[s.autoSubGear] - AUTO_UP[s.autoSubGear]) * sport;
    const downKmh =
      AUTO_DOWN[s.autoSubGear] + (AUTO_DOWN_KICK[s.autoSubGear] - AUTO_DOWN[s.autoSubGear]) * (sport * sport);
    if (s.shiftTimer <= 0 && s.autoSubGear < MAX_FORWARD_GEAR && fwdKmh >= upKmh) {
      s.autoSubGear += 1;
      s.shiftTimer = AUTO_SHIFT_DURATION_S;
    } else if (s.shiftTimer <= 0 && s.autoSubGear > 1 && fwdKmh < downKmh) {
      s.autoSubGear -= 1;
      s.shiftTimer = MANUAL_SHIFT_DURATION_S;
    }
  } else {
    s.autoSubGear = 1;
    s.shiftTimer = 0;
  }

  // Продольная динамика (инвариант №11: тормоз S гасит скорость до 0 и никогда не даёт задний ход)
  const isForwardGear = s.gear === "D" || isManualGear(s.gear);
  const activeForwardGear = isForwardGear ? s.autoSubGear : 0;
  let accel = computeEngineAccel(
    s.throttlePos,
    s.gear,
    s.autoSubGear,
    s.v,
    s.engineOn,
    s.handbrake,
    s.shiftTimer
  );

  const drag = computeRoadDragDecel(Math.abs(s.v), s.throttlePos, activeForwardGear, s.gear);
  if (s.v !== 0) {
    accel -= Math.sign(s.v) * drag;
  } else if (accel !== 0) {
    // Преодоление покоя: исключает микроколебания у 0 м/с при отпускании газа
    if (Math.abs(accel) <= drag) accel = 0;
    else accel -= Math.sign(accel) * drag;
  }

  const vBefore = s.v;
  s.v += accel * dt;
  // Сопротивление дороги никогда не разворачивает знак скорости против выбранной передачи
  if (vBefore !== 0 && Math.sign(s.v) !== Math.sign(vBefore)) {
    const wantsForward = isForwardGear && throttleCmd > 0.01 && s.engineOn && !s.handbrake;
    const wantsReverse = s.gear === "R" && throttleCmd > 0.01 && s.engineOn && !s.handbrake;
    if (!((wantsForward && s.v > 0) || (wantsReverse && s.v < 0))) {
      s.v = 0;
    }
  }
  // Жёсткий потолок скорости: ровно 180 км/ч (50.0 м/с) вперёд и 14 км/ч назад
  s.v = clamp(s.v, -MAX_REVERSE_KMH / 3.6, MAX_SPEED_MS);

  // Рабочий тормоз S
  if (brake > 0) {
    const dv = CAR.brakeDecel * brake * dt;
    if (Math.abs(s.v) <= dv) s.v = 0;
    else s.v -= Math.sign(s.v) * dv;
  }

  // Стояночный тормоз
  if (s.handbrake) {
    const dv = CAR.handbrakeDecel * dt;
    if (Math.abs(s.v) <= dv) s.v = 0;
    else s.v -= Math.sign(s.v) * dv;
  }

  // Плавные обороты ДВС (800..6450 об/мин, инерция маховика, ступени 1..6 и перегазовка в P/N)
  s.rpm = stepEngineRpm(
    s.rpm,
    s.throttlePos,
    s.gear,
    s.autoSubGear,
    s.v,
    s.engineOn,
    s.shiftTimer,
    dt
  );

  // Перемещение с дроблением шага (защита от проскакивания тонких бордюров)
  const subSteps = Math.min(12, Math.max(1, Math.ceil((Math.abs(s.v) * dt) / 0.12)));
  const subDt = dt / subSteps;
  let gridChecks = 0;
  let hitThisStep = false;
  let hitLabel = "";
  const speedBeforeHit = Math.abs(s.v) * 3.6;

  for (let i = 0; i < subSteps; i++) {
    if (s.v === 0) break;
    const px = s.x;
    const pz = s.z;
    const ph = s.h;
    const ds = s.v * subDt;

    const nextX = clamp(s.x + Math.sin(s.h) * ds, world.bounds.minX, world.bounds.maxX);
    const nextZ = clamp(s.z + Math.cos(s.h) * ds, world.bounds.minZ, world.bounds.maxZ);
    const nextH = s.h + (ds / CAR.wheelbase) * Math.tan(s.steer);
    if (isValidBoundaryPolygon(world.boundaryPolygon)) {
      const polyPos = clampCarToWorldBoundary(
        nextX,
        nextZ,
        nextH,
        CAR.width * 0.5,
        CAR.length * 0.5,
        world.bounds,
        world.boundaryPolygon
      );
      s.x = polyPos.x;
      s.z = polyPos.z;
    } else {
      s.x = nextX;
      s.z = nextZ;
    }
    s.h = nextH;

    const { hit, checked } = grid.queryCarHit(s.x, s.z, s.h);
    gridChecks = Math.max(gridChecks, checked);
    if (hit) {
      hitThisStep = true;
      hitLabel = hit.label || OBSTACLE_HIT_LABELS[hit.kind] || "препятствие";
      s.x = px;
      s.z = pz;
      s.h = ph;
      s.v = 0;
      break;
    } else {
      s.distanceTraveled += Math.abs(ds);
    }
  }

  if (hitThisStep) {
    if (!s.inContact) {
      s.collisions += 1;
      emit("collision", `Контакт: ${hitLabel} (скорость ${speedBeforeHit.toFixed(1)} км/ч)`);
    }
    s.inContact = true;
  } else if (Math.abs(s.v) > 0.08) {
    s.inContact = false;
  }

  // Колёса и крен/тангаж кузова
  s.wheelSpin += (s.v * dt) / CAR.wheelRadius;
  const aLong = dt > 0 ? clamp((s.v - s.prevV) / dt, -6, 6) : 0;
  s.prevV = s.v;
  if (aLong < -5.4 && brake > 0.9 && Math.abs(s.v) > 3.5 && s.speedingCooldown <= 0) {
    s.speedingCooldown = 4;
    emit("harsh_brake", `Резкое замедление (${Math.abs(aLong).toFixed(1)} м/с²)`);
  }
  const pitchTarget = clamp(-aLong * 0.006, -0.032, 0.032);
  const rollTarget = clamp(-s.v * s.steer * 0.022, -0.042, 0.042);
  const smooth = Math.min(1, dt * 6.5);
  s.pitch += (pitchTarget - s.pitch) * smooth;
  s.roll += (rollTarget - s.roll) * smooth;

  const absKmh = Math.abs(s.v) * 3.6;

  // Детектор начала движения: ремень и сигнал поворота
  if (absKmh > 1.2) {
    if (!s.hasMoved) {
      s.hasMoved = true;
      const isRoute = world.scenarioId === "city_osm" || world.checkpoints.length > 0;
      if (isRoute && s.signal !== "left" && s.signal !== "right" && !s.movedWithoutSignalFlagged) {
        s.movedWithoutSignalFlagged = true;
        emit(
          "no_turn_signal",
          s.signal === "hazard"
            ? "Начало движения на маршруте с аварийной сигнализацией (Z) вместо указателя поворота (Q/E)"
            : "Начало движения на маршруте без включения указателя поворота (Q/E)"
        );
      }
    }
    if (!s.belt && !s.movedWithoutBeltFlagged) {
      s.movedWithoutBeltFlagged = true;
      emit("belt_unfastened", "Движение с непристёгнутым ремнём безопасности");
    }
  }

  // Детектор превышения безопасной скорости задним ходом
  if (s.gear === "R" && s.v < 0 && absKmh > calibration.maxParkSpeedKmh + 1.5 && s.speedingCooldown <= 0) {
    s.speedingCooldown = 6;
    emit(
      "park_overspeed",
      `Скорость задним ходом ${absKmh.toFixed(1)} км/ч выше порога ${calibration.maxParkSpeedKmh} км/ч`
    );
  }

  // Детектор пересечения сплошной линии разметки парковочного бокса
  const crossedBay = findBayLineCross(s.x, s.z, s.h, world.bays);
  if (crossedBay) {
    if (!s.inLineCross) {
      emit("line_cross", `Наезд габаритом на линию разметки (${crossedBay.label})`);
    }
    s.inLineCross = true;
  } else {
    s.inLineCross = false;
  }

  // Городские детекторы: ограничение скорости, светофоры, пешеходы, контрольные точки
  const activeLimit = getActiveSpeedLimit(s.x, s.z, world);
  if (absKmh > activeLimit + 2 && s.speedingCooldown <= 0) {
    s.speedingCooldown = 7;
    emit("speed_limit", `Скорость ${absKmh.toFixed(0)} км/ч при ограничении ${activeLimit} км/ч`);
  }

  // Проверка светофоров и стоп-линий
  const frontDist = CAR.wheelbase / 2 + CAR.frontOverhang;
  const noseX = s.x + Math.sin(s.h) * frontDist;
  const noseZ = s.z + Math.cos(s.h) * frontDist;

  for (const sig of world.signals) {
    const dirAlign = Math.cos(s.h - sig.h);
    if (dirAlign < 0.62) continue; // Светофор встречного или поперечного направления
    const sfx = Math.sin(sig.h);
    const sfz = Math.cos(sig.h);
    const slx = Math.cos(sig.h);
    const slz = -Math.sin(sig.h);
    const dx = noseX - sig.stopLineX;
    const dz = noseZ - sig.stopLineZ;
    const along = dx * sfx + dz * sfz; // > 0 — нос пересёк стоп-линию
    const lateral = dx * slx + dz * slz;

    if (Math.abs(lateral) <= sig.stopLineWidth / 2 && along > 0.25 && along < 5.5) {
      const { phase, isForbidden } = getTrafficLightPhase(sig, s.time);
      if (isForbidden && !s.redLightPassedIds.includes(sig.id)) {
        s.redLightPassedIds = [...s.redLightPassedIds, sig.id];
        if (absKmh > 6.5 || along > 2.2) {
          emit(
            "red_light_run",
            `Проезд перекрёстка на запрещающий сигнал (${phase === "yellow" ? "жёлтый" : "красный"}, ${absKmh.toFixed(0)} км/ч)`
          );
        } else {
          emit("stop_line_cross", "Пересечение стоп-линии 1.12 при запрещающем сигнале светофора");
        }
      }
    } else if (along < -6 && s.redLightPassedIds.includes(sig.id)) {
      s.redLightPassedIds = s.redLightPassedIds.filter((id) => id !== sig.id);
    }
  }

  // Проверка уступления пешеходам на зебре
  for (const cw of world.crosswalks) {
    const ped = getPedestrianPose(cw, s.time);
    if (!ped.onRoadway) continue;
    const distToCrosswalk = Math.hypot(noseX - cw.cx, noseZ - cw.cz);
    const distToPed = Math.hypot(noseX - ped.x, noseZ - ped.z);
    if (distToCrosswalk < cw.length * 0.9 + 1.4 && distToPed < 6.2 && absKmh > 4.0 && s.pedestrianCooldown <= 0) {
      s.pedestrianCooldown = 8;
      emit("pedestrian_yield", `Проезд пешеходного перехода (${absKmh.toFixed(0)} км/ч), не уступив пешеходу`);
    }
  }

  // Контрольные точки городского маршрута (для requireStop засчитывается после полной остановки в зоне КТ;
  // если у финишной КТ выставлен isFinalPark, но на карте нет свободных боксов — завершаем маршрут на КТ)
  const hasFreeBay = world.bays.some((b) => !b.occupied);
  const currentCp = world.checkpoints[s.currentCheckpointIndex];
  let waitingStopAtCp = false;
  if (currentCp && (!currentCp.isFinalPark || !hasFreeBay)) {
    const dCp = Math.hypot(s.x - currentCp.x, s.z - currentCp.z);
    if (dCp <= currentCp.radius) {
      if (currentCp.requireStop && absKmh > 0.6) {
        waitingStopAtCp = true;
      } else {
        if (currentCp.requireSignal && s.signal !== currentCp.requireSignal) {
          const expected = currentCp.requireSignal === "right" ? "правый (E)" : "левый (Q)";
          emit("no_turn_signal", `Выполнение манёвра на КТ без указателя поворота — требовался ${expected}`);
        }
        s.completedCheckpointIds = [...s.completedCheckpointIds, currentCp.id];
        s.currentCheckpointIndex += 1;
      }
    }
  }

  // Все контрольные точки маршрута пройдены — маршрут завершён (у маршрута может не быть боксов)
  if (world.checkpoints.length > 0 && s.currentCheckpointIndex >= world.checkpoints.length && !s.finished) {
    s.finished = true;
    s.finishedReason = "completed";
  }

  // Проверка парковочного бокса
  const fullBay = findCompletedBay(s.x, s.z, s.h, world.bays);
  const partialBay = fullBay ?? findBayUnderCarCenter(s.x, s.z, world.bays);
  s.activeBayId = partialBay ? partialBay.id : null;

  const stopped = Math.abs(s.v) < 0.06;
  const readyForFinalBay =
    world.checkpoints.length === 0 ||
    s.currentCheckpointIndex >= world.checkpoints.length - 1;

  if (fullBay && stopped && readyForFinalBay) {
    s.holdTime += dt;
    if (s.holdTime >= calibration.holdDurationSec && !s.finished) {
      s.finished = true;
      s.finishedReason = "completed";
      s.finishedBayId = fullBay.id;
      if (currentCp?.isFinalPark && !s.completedCheckpointIds.includes(currentCp.id)) {
        s.completedCheckpointIds = [...s.completedCheckpointIds, currentCp.id];
        s.currentCheckpointIndex = world.checkpoints.length;
      }
      if ((s.gear === "P" || s.gear === "N") && s.handbrake) {
        s.neutralSecuredAfterFinish = true;
      } else {
        const neutralRule = ruleSet.rules.find((r) => r.code === "neutral_after_stop" && r.enabled);
        if (neutralRule) {
          emit("neutral_after_stop", "Парковка завершена без перевода КПП в N и включения стояночного тормоза");
        }
      }
    }
  } else {
    s.holdTime = 0;
  }

  if (s.finished && (s.gear === "P" || s.gear === "N") && s.handbrake) {
    s.neutralSecuredAfterFinish = true;
  }

  // Строка статуса и задания экзаменатора
  const activeCp = world.checkpoints[s.currentCheckpointIndex];
  if (!s.engineOn) {
    s.statusText = `Двигатель заглушен, КПП — ${s.gear === "P" ? "P (Parking)" : s.gear}. Нажмите I для запуска (или «Быстрый старт»).`;
  } else if (s.gear === "P" && !s.finished) {
    s.statusText = "Двигатель работает, КПП в P (Parking). Переключите передачу на Shift (или R / F) и снимите ручник (Space).";
  } else if (s.handbrake && !s.finished) {
    s.statusText = "Стояночный тормоз активен — снимите ручник (Space).";
  } else if (!s.belt) {
    s.statusText = "Пристегните ремень безопасности (B) перед началом движения.";
  } else if (s.finished && s.finishedBayId !== null) {
    s.statusText = `Упражнение выполнено (${fullBay?.label ?? `бокс №${s.finishedBayId}`})! Заезд записан — для нового нажмите «Сброс».`;
  } else if (s.finished && s.finishedReason === "completed" && world.checkpoints.length > 0) {
    s.statusText = "Маршрут завершён! Откройте «Разбор и Реплей», чтобы увидеть протокол, или нажмите «Сброс» для повтора.";
  } else if (s.inContact) {
    s.statusText = "Контакт с препятствием! Включите противоположную передачу и аккуратно отъезжайте.";
  } else if (s.inLineCross) {
    s.statusText = "Внимание: габарит пересёк линию разметки бокса!";
  } else if (fullBay && s.holdTime > 0 && readyForFinalBay) {
    const left = Math.max(0, calibration.holdDurationSec - s.holdTime).toFixed(1);
    s.statusText = `${fullBay.label}: удерживайте остановку ещё ${left} с...`;
  } else if (partialBay && readyForFinalBay) {
    s.statusText = `${partialBay.label}: заведите все 4 угла внутрь разметки и остановитесь.`;
  } else if (waitingStopAtCp && activeCp) {
    s.statusText = `Зона обязательной остановки (${s.currentCheckpointIndex + 1}/${world.checkpoints.length}): полностью остановите автомобиль (S).`;
  } else if (activeCp) {
    s.statusText = `Задание экзаменатора (${s.currentCheckpointIndex + 1}/${world.checkpoints.length}): ${activeCp.instruction}`;
  } else {
    s.statusText = world.examinerBrief;
  }

  return {
    state: s,
    newEvents,
    gridChecks,
    activeSpeedLimitKmh: activeLimit,
  };
}
