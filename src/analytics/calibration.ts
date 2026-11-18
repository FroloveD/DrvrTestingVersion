/**
 * @module analytics/calibration
 * @layer pure-core
 * @role Сверка вердиктов симулятора с независимыми оценками инструкторов и доверительный интервал Уилсона (95 %).
 * @invariants #7 (чистое ядро), #16 (цель ≥ 90 % совпадений на ≥ 20 оценках перед подписью `instructor_signed`).
 * @tests T19
 */
import { evaluateAttempt, type RuleSet } from "../scoring/rules";
import { normalizeName, type AttemptMeta } from "../sim/journal";
import { studentOf } from "./summary";

/**
 * Сверка вердиктов симулятора с вердиктами инструкторов.
 * Метрика этапа «Доверие к оценке»: доля совпадений не ниже 90 % на эталонной выборке.
 *
 * Вердикт симулятора пересчитывается по ТЕКУЩЕМУ набору правил: так видно, как правка
 * весов и порога в кабинете инструктора меняет согласие, без повторных заездов.
 */

/** Целевая доля совпадений, %. */
export const AGREEMENT_TARGET = 90;
/**
 * Минимум оценок, при котором делается вывод о достижении цели.
 * Значение выбрано под план (10–20 заездов × 2–3 инструктора) и не является нормативом:
 * при меньшей выборке процент показывается, но статус остаётся «мало данных».
 */
export const MIN_REVIEWS_FOR_VERDICT = 20;

export type AgreementStatus = "no_data" | "insufficient" | "below_target" | "meets_target";

export type Disagreement = {
  attemptId: string;
  createdAt: string;
  scenarioTitle: string;
  student: string;
  instructor: string;
  instructorVerdict: "СДАЛ" | "НЕ СДАЛ";
  simVerdict: "СДАЛ" | "НЕ СДАЛ";
  simPoints: number;
  /** sim_too_lenient — симулятор пропустил то, что инструктор считает провалом. */
  kind: "sim_too_lenient" | "sim_too_strict";
  violations: string[];
  comment: string;
};

export type AgreementSummary = {
  reviewedAttempts: number;
  reviews: number;
  agree: number;
  agreementRate: number | null;
  /** Границы 95 % интервала Уилсона, %. Ориентир: оценки одного заезда не независимы. */
  intervalLow: number | null;
  intervalHigh: number | null;
  simTooLenient: number;
  simTooStrict: number;
  /** Попытки, по которым инструкторы разошлись между собой. */
  instructorsSplit: number;
  instructors: Array<{ name: string; reviews: number; agree: number; rate: number }>;
  status: AgreementStatus;
  target: number;
  minReviews: number;
  disagreements: Disagreement[];
};

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Доверительный интервал Уилсона (95 %) для доли, в процентах. */
export function wilsonInterval(successes: number, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    low: round1(Math.max(0, center - half) * 100),
    high: round1(Math.min(1, center + half) * 100),
  };
}

export function summarizeAgreement(
  attempts: readonly AttemptMeta[],
  ruleSet: RuleSet,
  target: number = AGREEMENT_TARGET,
  minReviews: number = MIN_REVIEWS_FOR_VERDICT
): AgreementSummary {
  let reviewedAttempts = 0;
  let reviews = 0;
  let agree = 0;
  let simTooLenient = 0;
  let simTooStrict = 0;
  let instructorsSplit = 0;
  const perInstructor = new Map<string, { name: string; reviews: number; agree: number }>();
  const disagreements: Disagreement[] = [];

  for (const a of attempts) {
    const list = a.reviews ?? [];
    if (list.length === 0) continue;
    reviewedAttempts += 1;

    const sim = evaluateAttempt(a.events, a.evaluation.collisions, ruleSet);
    if (new Set(list.map((r) => r.verdict)).size > 1) instructorsSplit += 1;

    for (const r of list) {
      reviews += 1;
      const key = normalizeName(r.instructor);
      const stat = perInstructor.get(key) ?? { name: r.instructor, reviews: 0, agree: 0 };
      stat.reviews += 1;

      if (r.verdict === sim.verdict) {
        agree += 1;
        stat.agree += 1;
      } else {
        const kind = sim.verdict === "СДАЛ" ? "sim_too_lenient" : "sim_too_strict";
        if (kind === "sim_too_lenient") simTooLenient += 1;
        else simTooStrict += 1;
        disagreements.push({
          attemptId: a.id,
          createdAt: a.createdAt,
          scenarioTitle: a.scenarioTitle,
          student: studentOf(a),
          instructor: r.instructor,
          instructorVerdict: r.verdict,
          simVerdict: sim.verdict,
          simPoints: sim.totalPoints,
          kind,
          violations: sim.items.map((i) => i.rule.title),
          comment: r.comment ?? "",
        });
      }
      perInstructor.set(key, stat);
    }
  }

  const interval = wilsonInterval(agree, reviews);
  // Сравнение в целых числах: без погрешности деления на границе 90 %
  const status: AgreementStatus =
    reviews === 0
      ? "no_data"
      : reviews < minReviews
        ? "insufficient"
        : agree * 100 >= target * reviews
          ? "meets_target"
          : "below_target";

  // Сначала случаи, когда симулятор мягче инструктора: они опаснее для обучения
  disagreements.sort((x, y) =>
    x.kind === y.kind ? (x.createdAt < y.createdAt ? 1 : -1) : x.kind === "sim_too_lenient" ? -1 : 1
  );

  return {
    reviewedAttempts,
    reviews,
    agree,
    agreementRate: reviews > 0 ? round1((agree / reviews) * 100) : null,
    intervalLow: interval?.low ?? null,
    intervalHigh: interval?.high ?? null,
    simTooLenient,
    simTooStrict,
    instructorsSplit,
    instructors: [...perInstructor.values()]
      .map((s) => ({ ...s, rate: round1((s.agree / s.reviews) * 100) }))
      .sort((x, y) => y.reviews - x.reviews || x.name.localeCompare(y.name, "ru")),
    status,
    target,
    minReviews,
    disagreements,
  };
}
