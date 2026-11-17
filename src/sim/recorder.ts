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
  count: number;
  input: InputState;
};

export type RecordedAttempt = {
  id: string;
  createdAt: string;
  scenarioId: ScenarioId;
  scenarioTitle: string;
  readyStart: boolean;
  totalTicks: number;
  durationSec: number;
  distanceMeters: number;
  finished: boolean;
  finishedBayId: number | null;
  calibration: CalibrationConfig;
  events: SimEvent[];
  evaluation: EvaluationResult;
  trajectory: TrajectorySample[];
  inputStream: RleInputFrame[]; // позволяет детерминированно воспроизвести заезд шаг в шаг
  finalPose: { x: number; z: number; h: number };
  /** Снимок мира — только для scenarioId "custom", чтобы реплей не зависел от текущего редактора. */
  customWorld?: WorldData;
};

function inputsEqual(a: InputState, b: InputState): boolean {
  return (
    a.throttle === b.throttle &&
    a.brake === b.brake &&
    Math.abs(a.steerWheelDeg - b.steerWheelDeg) < 0.001 &&
    a.gear === b.gear &&
    a.engineOn === b.engineOn &&
    a.handbrake === b.handbrake &&
    a.belt === b.belt &&
    a.lights === b.lights &&
    a.signal === b.signal
  );
}

function cloneInput(i: InputState): InputState {
  return { ...i };
}

export class AttemptRecorder {
  private rle: RleInputFrame[] = [];
  private samples: TrajectorySample[] = [];
  private events: SimEvent[] = [];
  private readonly readyStart: boolean;

  constructor(initialState: SimState, readyStart: boolean) {
    this.readyStart = readyStart;
    this.pushSample(initialState);
  }

  recordTick(input: InputState, state: SimState, newEvents: readonly SimEvent[]): void {
    // RLE-сжатие потока ввода (ограничиваем до 36 000 тиков = 10 минут 60 Гц)
    if (state.tick <= 36_000) {
      const snapped: InputState = {
        ...cloneInput(input),
        throttle: Number(input.throttle.toFixed(3)),
        brake: Number(input.brake.toFixed(3)),
        steerWheelDeg: Number(input.steerWheelDeg.toFixed(1)),
      };
      const last = this.rle[this.rle.length - 1];
      if (last && inputsEqual(last.input, snapped)) {
        last.count += 1;
      } else {
        this.rle.push({ count: 1, input: snapped });
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
    ruleSet: RuleSet
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
    return {
      id: `att-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      scenarioId: world.scenarioId,
      scenarioTitle: world.title,
      readyStart: this.readyStart,
      totalTicks: state.tick,
      durationSec: Number(state.time.toFixed(1)),
      distanceMeters: Number(state.distanceTraveled.toFixed(1)),
      finished: state.finished,
      finishedBayId: state.finishedBayId,
      calibration: { ...calibration },
      events: [...this.events],
      evaluation,
      trajectory: traj,
      inputStream: this.rle.map((f) => ({ count: f.count, input: cloneInput(f.input) })),
      finalPose: {
        x: Number(state.x.toFixed(3)),
        z: Number(state.z.toFixed(3)),
        h: Number(state.h.toFixed(4)),
      },
      ...(world.scenarioId === "custom"
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
  let state = createInitialState(world, readyStart);
  const events: SimEvent[] = [];

  for (const frame of stream) {
    for (let i = 0; i < frame.count; i++) {
      const out = stepSimulation(state, frame.input, world, grid, calibration, ruleSet, FIXED_DT);
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

const JOURNAL_KEY = "cdt.attempts.journal.v1";

export function loadAttemptJournal(): RecordedAttempt[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecordedAttempt[]).slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function saveAttemptToJournal(attempt: RecordedAttempt): RecordedAttempt[] {
  const existing = loadAttemptJournal().filter((a) => a.id !== attempt.id);
  // Для компактного хранения в localStorage оставляем до 600 точек траектории
  const compact: RecordedAttempt = {
    ...attempt,
    trajectory:
      attempt.trajectory.length > 600
        ? attempt.trajectory.filter((_, i) => i % Math.ceil(attempt.trajectory.length / 600) === 0)
        : attempt.trajectory,
    inputStream: attempt.inputStream.slice(0, 800),
  };
  const next = [compact, ...existing].slice(0, 20);
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(next));
  } catch {
    // Игнорируем переполнение квоты или приватный режим браузера
  }
  return next;
}

export function clearAttemptJournal(): void {
  try {
    localStorage.removeItem(JOURNAL_KEY);
  } catch {
    // noop
  }
}
