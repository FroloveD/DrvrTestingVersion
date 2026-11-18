/**
 * @module analytics/summary
 * @layer pure-core
 * @role Агрегация статистики по ученикам, упражнениям и нарушениям, выгрузка CSV (для Excel) и сводного Markdown-отчёта.
 * @invariants #7 (чистое ядро), #8 (локальная обработка без сервера), #16 (явный статус правил и учебный дисклеймер в отчёте).
 * @tests T18, T26
 */
import { evaluateAttempt, type RuleSet } from "../scoring/rules";
import type { AttemptMeta } from "../sim/journal";
import type { ScenarioId, SimEventCode } from "../sim/types";
import type { AgreementStatus, AgreementSummary } from "./calibration";

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

function escapeMdCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const AGREEMENT_STATUS_TEXT: Record<AgreementStatus, string> = {
  no_data: "оценок инструкторов пока нет",
  insufficient: "мало данных для вывода",
  below_target: "ниже целевого порога",
  meets_target: "целевой порог достигнут",
};

/**
 * Формирует читаемый сводный Markdown-отчёт для инструктора, автошколы и протокола калибровки.
 * Чистая функция без DOM; дата передаётся снаружи для детерминированности тестов.
 *
 * @param summary Сводная статистика попыток (`summarizeAttempts`).
 * @param agreement Сводка сверки вердиктов с инструкторами (`summarizeAgreement`).
 * @param ruleSet Активный набор правил (версия, статус `unvalidated` / `instructor_signed`, порог).
 * @param reportDate Дата отчёта в формате `YYYY-MM-DD` (по умолчанию текущая дата UTC).
 */
export function analyticsToMarkdown(
  summary: AnalyticsSummary,
  agreement: AgreementSummary,
  ruleSet: RuleSet,
  reportDate: string = new Date().toISOString().slice(0, 10)
): string {
  const statusText =
    ruleSet.status === "instructor_signed"
      ? `instructor_signed (подписано: ${ruleSet.instructorSignOff || "ФИО не указано"})`
      : "unvalidated (предварительный демо-профиль, требует сверки с инструктором)";

  const L: string[] = [];
  L.push(`# CityDrivingTraining — сводный учебный отчёт (${reportDate})`);
  L.push("");
  L.push(`- **Версия правил:** \`${ruleSet.version}\` (порог несдачи: ${ruleSet.failThreshold} б., от ${ruleSet.effectiveFrom})`);
  L.push(`- **Статус правил:** ${statusText}`);
  L.push(`- **Источник правил:** ${ruleSet.source}`);
  L.push("");

  L.push("## 1. Общие показатели выборки");
  L.push("");
  L.push("| Показатель | Значение |");
  L.push("|---|---|");
  L.push(`| Всего попыток | ${summary.total} |`);
  L.push(`| СДАЛ / НЕ СДАЛ | ${summary.passed} / ${summary.failed} |`);
  L.push(`| Доля сдачи | ${summary.passRate}% |`);
  L.push(`| Средние штрафные баллы | ${summary.avgPoints} |`);
  L.push(`| Средняя длительность | ${summary.avgDurationSec} с |`);
  L.push("");

  L.push("## 2. Сверка вердиктов с инструкторами");
  L.push("");
  L.push(
    `- **Статус:** ${AGREEMENT_STATUS_TEXT[agreement.status]} (цель ≥ ${agreement.target}% при выборке ≥ ${agreement.minReviews} оценок)`
  );
  if (agreement.reviews > 0 && agreement.agreementRate !== null) {
    const ci =
      agreement.intervalLow !== null && agreement.intervalHigh !== null
        ? `, 95% ДИ Уилсона ${agreement.intervalLow}–${agreement.intervalHigh}%`
        : "";
    L.push(
      `- **Совпадение:** ${agreement.agree} из ${agreement.reviews} оценок (${agreement.agreementRate}%${ci}) по ${agreement.reviewedAttempts} попыткам`
    );
    L.push(
      `- **Расхождения:** симулятор мягче — ${agreement.simTooLenient}, симулятор строже — ${agreement.simTooStrict}, разногласия между инструкторами — ${agreement.instructorsSplit}`
    );
    if (agreement.disagreements.length > 0) {
      L.push("");
      L.push("| Попытка | Ученик | Сценарий | Инструктор | Симулятор | Тип | Комментарий |");
      L.push("|---|---|---|---|---|---|---|");
      for (const d of agreement.disagreements) {
        const kindLabel = d.kind === "sim_too_lenient" ? "симулятор мягче" : "симулятор строже";
        L.push(
          `| \`${escapeMdCell(d.attemptId)}\` | ${escapeMdCell(d.student)} | ${escapeMdCell(d.scenarioTitle)} | ${escapeMdCell(d.instructor)}: ${d.instructorVerdict} | ${d.simVerdict} (${d.simPoints} б.) | ${kindLabel} | ${escapeMdCell(d.comment || "—")} |`
        );
      }
    }
  }
  L.push("");

  if (summary.students.length > 0) {
    L.push("## 3. Результаты по ученикам");
    L.push("");
    L.push("| Ученик | Попыток | СДАЛ | НЕ СДАЛ | Доля сдачи | Средний балл | Лучший балл |");
    L.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const st of summary.students) {
      L.push(
        `| ${escapeMdCell(st.student)} | ${st.attempts} | ${st.passed} | ${st.failed} | ${st.passRate}% | ${st.avgPoints} | ${st.bestPoints} |`
      );
    }
    L.push("");
  }

  if (summary.scenarios.length > 0) {
    L.push("## 4. Разбивка по упражнениям");
    L.push("");
    L.push("| Упражнение | Попыток | Доля сдачи |");
    L.push("|---|---:|---:|");
    for (const sc of summary.scenarios) {
      L.push(`| ${escapeMdCell(sc.title)} | ${sc.attempts} | ${sc.passRate}% |`);
    }
    L.push("");
  }

  L.push("## 5. Частые нарушения и фокус отработки");
  L.push("");
  if (summary.violations.length === 0) {
    L.push("Нарушений в выбранных попытках не зафиксировано.");
  } else {
    L.push("| Нарушение | Баллы | Повторений |");
    L.push("|---|---:|---:|");
    for (const v of summary.violations) {
      L.push(`| ${escapeMdCell(v.title)} (\`${v.code}\`) | ${v.points} | ${v.count} |`);
    }
    const top = summary.violations.slice(0, 3).map((v) => `«${v.title}» (${v.count})`);
    L.push("");
    L.push(`**Приоритет для разбора с инструктором:** ${top.join(", ")}.`);
  }
  L.push("");
  L.push("---");
  L.push("Учебная симуляция. Не является официальным экзаменом ГИБДД и не заменяет обучение с инструктором.");
  return L.join("\n") + "\n";
}
