/**
 * @module analytics/summary
 * @layer pure-core
 * @role Агрегация статистики по ученикам, упражнениям и нарушениям, а также выгрузка CSV (UTF-8 BOM, `;`) для Excel.
 * @invariants #7 (чистое ядро), #8 (локальная обработка без сервера).
 * @tests T18
 */
import { evaluateAttempt, type RuleSet } from "../scoring/rules";
import type { AttemptMeta } from "../sim/journal";
import type { ScenarioId, SimEventCode } from "../sim/types";

export type StudentStat = {
  student: string;
  attempts: number;
  passed: number;
  failed: number;
  passRate: number; // 0..100
  avgPoints: number;
  bestPoints: number;
  avgDurationSec: number;
  lastAttemptAt: string | null;
};

export type ViolationStat = {
  code: SimEventCode;
  title: string;
  points: number;
  count: number;
};

export type ScenarioStat = {
  scenarioId: ScenarioId;
  title: string;
  attempts: number;
  passRate: number;
};

export type AnalyticsSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgPoints: number;
  avgDurationSec: number;
  students: StudentStat[];
  violations: ViolationStat[];
  scenarios: ScenarioStat[];
};

export const UNKNOWN_STUDENT = "Без имени";

export function studentOf(attempt: Pick<AttemptMeta, "student">): string {
  const s = attempt.student?.trim();
  return s && s.length > 0 ? s : UNKNOWN_STUDENT;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

type Acc = { attempts: number; passed: number; points: number; duration: number; best: number; last: string | null };

/**
 * Агрегирует попытки для кабинета инструктора. Чистая функция, без DOM и хранилища.
 * Вердикты пересчитываются по переданному набору правил; суммы копятся без округления
 * и округляются один раз в конце.
 */
export function summarizeAttempts(attempts: readonly AttemptMeta[], ruleSet: RuleSet): AnalyticsSummary {
  const total = attempts.length;
  if (total === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      avgPoints: 0,
      avgDurationSec: 0,
      students: [],
      violations: [],
      scenarios: [],
    };
  }

  const students = new Map<string, Acc>();
  const violations = new Map<SimEventCode, ViolationStat>();
  const scenarios = new Map<ScenarioId, { title: string; attempts: number; passed: number }>();
  let passed = 0;
  let pointsSum = 0;
  let durationSum = 0;

  for (const a of attempts) {
    const evalRes = evaluateAttempt(a.events, a.evaluation.collisions, ruleSet);
    const ok = evalRes.verdict === "СДАЛ";
    if (ok) passed += 1;
    pointsSum += evalRes.totalPoints;
    durationSum += a.durationSec;

    const name = studentOf(a);
    const acc = students.get(name) ?? { attempts: 0, passed: 0, points: 0, duration: 0, best: Infinity, last: null };
    acc.attempts += 1;
    if (ok) acc.passed += 1;
    acc.points += evalRes.totalPoints;
    acc.duration += a.durationSec;
    acc.best = Math.min(acc.best, evalRes.totalPoints);
    if (!acc.last || a.createdAt > acc.last) acc.last = a.createdAt;
    students.set(name, acc);

    for (const item of evalRes.items) {
      const existing = violations.get(item.rule.code);
      if (existing) existing.count += 1;
      else {
        violations.set(item.rule.code, {
          code: item.rule.code,
          title: item.rule.title,
          points: item.appliedPoints,
          count: 1,
        });
      }
    }

    const sc = scenarios.get(a.scenarioId) ?? { title: a.scenarioTitle, attempts: 0, passed: 0 };
    sc.attempts += 1;
    if (ok) sc.passed += 1;
    scenarios.set(a.scenarioId, sc);
  }

  return {
    total,
    passed,
    failed: total - passed,
    passRate: round1((passed / total) * 100),
    avgPoints: round1(pointsSum / total),
    avgDurationSec: round1(durationSum / total),
    students: [...students.entries()]
      .map(([student, acc]) => ({
        student,
        attempts: acc.attempts,
        passed: acc.passed,
        failed: acc.attempts - acc.passed,
        passRate: round1((acc.passed / acc.attempts) * 100),
        avgPoints: round1(acc.points / acc.attempts),
        bestPoints: acc.best,
        avgDurationSec: round1(acc.duration / acc.attempts),
        lastAttemptAt: acc.last,
      }))
      .sort((a, b) => b.attempts - a.attempts || a.student.localeCompare(b.student, "ru")),
    violations: [...violations.values()].sort((a, b) => b.count - a.count || b.points - a.points),
    scenarios: [...scenarios.entries()]
      .map(([scenarioId, sc]) => ({
        scenarioId,
        title: sc.title,
        attempts: sc.attempts,
        passRate: round1((sc.passed / sc.attempts) * 100),
      }))
      .sort((a, b) => b.attempts - a.attempts),
  };
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV для Excel школ: разделитель «;», BOM добавляется при скачивании. */
export function attemptsToCsv(attempts: readonly AttemptMeta[], ruleSet: RuleSet): string {
  const header = [
    "Дата",
    "Ученик",
    "Сценарий",
    "Вердикт симулятора",
    "Штрафные баллы",
    "Балл v8",
    "Нарушения",
    "Вердикты инструкторов",
    "Длительность, с",
    "Дистанция, м",
    "Версия правил",
    "ID попытки",
  ];
  const rows = attempts.map((a) => {
    const ev = evaluateAttempt(a.events, a.evaluation.collisions, ruleSet);
    const codes = ev.items.map((i) => `${i.rule.clause} ${i.rule.title}`).join("; ");
    const reviews = (a.reviews ?? []).map((r) => `${r.instructor}: ${r.verdict}`).join("; ");
    return [
      new Date(a.createdAt).toLocaleString("ru-RU"),
      studentOf(a),
      a.scenarioTitle,
      ev.verdict,
      ev.totalPoints,
      ev.legacyV8Score,
      codes || "нет",
      reviews || "нет",
      a.durationSec,
      a.distanceMeters,
      ev.rulesVersion,
      a.id,
    ];
  });
  return [header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
}
