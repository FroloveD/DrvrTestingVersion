import type { RuleSet } from "../scoring/rules";
import type { RecordedAttempt } from "./recorder";
import type { CalibrationConfig, ScenarioId, WorldData } from "./types";

/**
 * Golden-набор — артефакт для калибровки с инструктором и CI:
 * ввод, события и позы сохраняются вместе с версией правил и контрольной суммой.
 * Одна и та же попытка даёт один и тот же checksum (без дат и случайных id).
 */
export type GoldenAttempt = {
  scenarioId: ScenarioId;
  scenarioTitle: string;
  checksum: string;
  rulesVersion: string;
  verdict: "СДАЛ" | "НЕ СДАЛ";
  totalPoints: number;
  events: RecordedAttempt["events"];
  trajectory: RecordedAttempt["trajectory"];
  inputStream: RecordedAttempt["inputStream"];
  inputTicks: number;
  finalPose: RecordedAttempt["finalPose"];
  calibration: CalibrationConfig;
  customWorld?: WorldData;
};

export type GoldenSet = {
  schema: "cdt.golden.v1";
  generatedAt: string;
  ruleset: Pick<RuleSet, "version" | "status" | "failThreshold" | "effectiveFrom" | "source">;
  vehicle: {
    model: string;
    lengthM: number;
    widthM: number;
    wheelbaseM: number;
    maxSteerDeg: number;
  };
  attempts: GoldenAttempt[];
};

/** Детерминированный FNV-1a хэш (32 бита, hex) для контрольной суммы заезда. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function attemptChecksum(attempt: RecordedAttempt): string {
  const payload = JSON.stringify({
    scenarioId: attempt.scenarioId,
    finalPose: attempt.finalPose,
    events: attempt.events.map((e) => [e.code, e.tick, e.x, e.z]),
    input: attempt.inputStream.map((f) => [f.count, f.input.gear, f.input.signal, f.input.steerWheelDeg]),
  });
  return fnv1a(payload);
}

export function buildGoldenSet(
  attempts: readonly RecordedAttempt[],
  rules: RuleSet,
  vehicle: { model: string; length: number; width: number; wheelbase: number; maxSteerDeg: number }
): GoldenSet {
  return {
    schema: "cdt.golden.v1",
    generatedAt: new Date().toISOString(),
    ruleset: {
      version: rules.version,
      status: rules.status,
      failThreshold: rules.failThreshold,
      effectiveFrom: rules.effectiveFrom,
      source: rules.source,
    },
    vehicle: {
      model: vehicle.model,
      lengthM: vehicle.length,
      widthM: vehicle.width,
      wheelbaseM: vehicle.wheelbase,
      maxSteerDeg: Number(vehicle.maxSteerDeg.toFixed(2)),
    },
    attempts: attempts.map((a) => ({
      scenarioId: a.scenarioId,
      scenarioTitle: a.scenarioTitle,
      checksum: attemptChecksum(a),
      rulesVersion: a.evaluation.rulesVersion,
      verdict: a.evaluation.verdict,
      totalPoints: a.evaluation.totalPoints,
      events: a.events,
      trajectory: a.trajectory,
      inputStream: a.inputStream,
      inputTicks: a.inputStream.reduce((sum, f) => sum + f.count, 0),
      finalPose: a.finalPose,
      calibration: a.calibration,
      ...(a.customWorld ? { customWorld: a.customWorld } : {}),
    })),
  };
}
