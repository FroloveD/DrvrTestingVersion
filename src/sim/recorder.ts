import { evaluateAttempt, type EvaluationResult, type RuleSet } from "../scoring/rules";
import { SpatialGrid } from "./spatialGrid";
import { createInitialState, stepSimulation } from "./step";
import type {
  CalibrationConfig,
  InputState,
  ScenarioId,
  SimEvent,
  SimState,
  WorldData,
} from "./types";
import { FIXED_DT } from "./vehicle";

export type TrajectorySample = {
  t: number;
  x: number;
  z: number;
  h: number;
  vKmh: number;
  gear: InputState["gear"];
  swDeg: number;
};

export type RleInputFrame = {
  /** Настройка, действовавшая в этом блоке ввода. Опциональна для старых реплеев. */
  maxInnerWheelDeg?: number;
  count: number;
  input: InputState;
};

/** Независимый вердикт инструктора по попытке — для сверки с оценкой симулятора. */
export type InstructorReview = {
  instructor: string;
  verdict: "СДАЛ" | "НЕ СДАЛ";
  comment?: string;
  reviewedAt: string;
};

export type RecordedAttempt = {
  id: string;
  createdAt: string;
  /** Ученик, за которым закреплена попытка (кабинет инструктора). */
  student?: string;
  /** Вердикты инструкторов: не больше одного на инструктора. */
  reviews?: InstructorReview[];
  scenarioId: ScenarioId;
  scenarioTitle: string;
  readyStart: boolean;
  totalTicks: number;
  durationSec: number;
  distanceMeters: number;
  finished: boolean;
  /**
   * Запись попытки закрыта пользователем («Завершить → Разбор» или зачёт упражнения).
   * false — страховочная копия незавершённого заезда; после закрытия ввод не пишется.
   */
  closed?: boolean;
  finishedBayId: number | null;
  calibration: CalibrationConfig;
  events: SimEvent[];
  evaluation: EvaluationResult;
  trajectory: TrajectorySample[];
  inputStream: RleInputFrame[]; // позволяет детерминированно воспроизвести заезд шаг в шаг
  finalPose: { x: number; z: number; h: number };
  /** Снимок мира — только для scenarioId "custom", чтобы реплей не зависел от текущего редактора. */
  customWorld?: WorldData;
  /**
   * Правила, действовавшие во время заезда. Нужны реплею: строгий режим
   * (остановка на первой грубой ошибке) влияет на само движение, а не только на баллы.
   */
  rulesAtRide?: RuleSet;
};

/** Предел записи ввода: 10 минут при 60 Гц. Дальше заезд продолжается, но реплей неполон. */
export const MAX_RECORDED_TICKS = 36_000;

/**
 * Квантует аналоговый ввод (руль 0,1°, педали 0,001).
 * Вызывается ДО шага симуляции: ядро и запись получают одни и те же значения,
 * а одинаковые соседние кадры лучше сжимаются RLE.
 */
export function quantizeInput(input: InputState): InputState {
  input.steerWheelDeg = Math.round(input.steerWheelDeg * 10) / 10 + 0;
  input.throttle = Math.round(input.throttle * 1000) / 1000;
  input.brake = Math.round(input.brake * 1000) / 1000;
  return input;
}

/** Строгое сравнение: кадры объединяются, только если ввод совпадает точно. */
function inputsEqual(a: InputState, b: InputState): boolean {
  return (
    a.throttle === b.throttle &&
    a.brake === b.brake &&
    a.steerWheelDeg === b.steerWheelDeg &&
    a.gear === b.gear &&
    a.engineOn === b.engineOn &&
    a.handbrake === b.handbrake &&
    a.belt === b.belt &&
    a.lights === b.lights &&
    a.signal === b.signal
  );
}

function newAttemptId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class AttemptRecorder {
  /** Идентификатор постоянен: повторный snapshot обновляет ту же запись журнала, а не создаёт новую. */
  readonly id: string = newAttemptId();
  private createdAt: string | null = null;
  private rle: RleInputFrame[] = [];
  private samples: TrajectorySample[] = [];
  private events: SimEvent[] = [];
  private readonly readyStart: boolean;

  constructor(initialState: SimState, readyStart: boolean) {
    this.readyStart = readyStart;
    this.pushSample(initialState);
  }

  /**
   * Записывает ввод ровно таким, каким его получило ядро, — без округления.
   * Иначе реплей расходится с заездом (раньше руль округлялся до 0,1° уже после шага).
   */
  recordTick(input: InputState, state: SimState, newEvents: readonly SimEvent[]): void {
    if (state.tick <= MAX_RECORDED_TICKS) {
      const last = this.rle[this.rle.length - 1];
      if (last && last.maxInnerWheelDeg === state.maxInnerWheelDeg && inputsEqual(last.input, input)) {
        last.count += 1;
      } else {
        this.rle.push({ count: 1, input: { ...input }, maxInnerWheelDeg: state.maxInnerWheelDeg });
      }
    }

    if (newEvents.length > 0) {
      this.events.push(...newEvents);
    }

    // Сэмпл траектории каждые 6 тиков (10 Гц) для плавного 2D/3D-реплея
    if (state.tick % 6 === 0 || newEvents.length > 0) {
      this.pushSample(state);
    }
  }

  getEvents(): readonly SimEvent[] {
    return this.events;
  }

  getTrajectory(): readonly TrajectorySample[] {
    return this.samples;
  }

  private pushSample(s: SimState): void {
    if (this.samples.length > 6000) return;
    this.samples.push({
      t: Number(s.time.toFixed(2)),
      x: Number(s.x.toFixed(2)),
      z: Number(s.z.toFixed(2)),
      h: Number(s.h.toFixed(3)),
      vKmh: Number((s.v * 3.6).toFixed(1)),
      gear: s.gear,
      swDeg: Number(s.swDeg.toFixed(1)),
    });
  }

  snapshot(
    state: SimState,
    world: WorldData,
    calibration: CalibrationConfig,
    ruleSet: RuleSet,
    closed = true
  ): RecordedAttempt {
    const evaluation = evaluateAttempt(this.events, state.collisions, ruleSet);
    const traj = [...this.samples];
    const last = traj[traj.length - 1];
    if (!last || Math.abs(last.t - state.time) > 0.05) {
      traj.push({
        t: Number(state.time.toFixed(2)),
        x: Number(state.x.toFixed(2)),
        z: Number(state.z.toFixed(2)),
        h: Number(state.h.toFixed(3)),
        vKmh: Number((state.v * 3.6).toFixed(1)),
        gear: state.gear,
        swDeg: Number(state.swDeg.toFixed(1)),
      });
    }
    // Дата фиксируется при первом сохранении и больше не меняется
    if (this.createdAt === null) this.createdAt = new Date().toISOString();
    return {
      id: this.id,
      createdAt: this.createdAt,
      scenarioId: world.scenarioId,
      scenarioTitle: world.title,
      readyStart: this.readyStart,
      totalTicks: state.tick,
      durationSec: Number(state.time.toFixed(1)),
      distanceMeters: Number(state.distanceTraveled.toFixed(1)),
      finished: state.finished,
      closed,
      finishedBayId: state.finishedBayId,
      calibration: { ...calibration },
      events: [...this.events],
      evaluation,
      trajectory: traj,
      inputStream: this.rle.map((f) => ({ ...f, input: { ...f.input } })),
      // Без округления: проверка детерминизма сравнивает позу реплея с этой точно
      finalPose: { x: state.x, z: state.z, h: state.h },
      rulesAtRide: JSON.parse(JSON.stringify(ruleSet)) as RuleSet,
      ...(world.embedInAttempt || world.scenarioId === "custom"
        ? { customWorld: JSON.parse(JSON.stringify(world)) as WorldData }
        : {}),
    };
  }
}

/**
 * Детерминированно прогоняет записанный RLE-поток ввода через чистое ядро
 * и возвращает итоговое состояние и события (для верификации и golden-тестов).
 */
export function replayInputStream(
  stream: readonly RleInputFrame[],
  world: WorldData,
  calibration: CalibrationConfig,
  ruleSet: RuleSet,
  readyStart: boolean
): { finalState: SimState; events: SimEvent[]; evaluation: EvaluationResult } {
  const grid = new SpatialGrid(world.obstacles, 10);
  let state = createInitialState(world, readyStart, stream[0]?.maxInnerWheelDeg ?? calibration.maxInnerWheelDeg);
  const events: SimEvent[] = [];

  for (const frame of stream) {
    const frameCalibration = frame.maxInnerWheelDeg === undefined
      ? calibration
      : { ...calibration, maxInnerWheelDeg: frame.maxInnerWheelDeg };
    for (let i = 0; i < frame.count; i++) {
      const out = stepSimulation(state, frame.input, world, grid, frameCalibration, ruleSet, FIXED_DT);
      state = out.state;
      if (out.newEvents.length) events.push(...out.newEvents);
    }
  }
  return {
    finalState: state,
    events,
    evaluation: evaluateAttempt(events, state.collisions, ruleSet),
  };
}
