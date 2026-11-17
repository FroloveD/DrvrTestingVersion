import { evaluateAttempt, type RuleSet } from "../scoring/rules";
import { attemptChecksum } from "../sim/golden";
import type { RecordedAttempt } from "../sim/recorder";
import type { ScenarioId, SimEventCode } from "../sim/types";

/**
 * Отчёт для автошколы — чистая агрегация журнала попыток.
 * Без DOM и localStorage, поэтому тестируется в Node (selfTest T17).
 * Минимизация персональных данных: только необязательная подпись ученика/группы.
 */
export type StudentMeta = {
  label: string; // подпись ученика (опционально, только локально)
  group: string;
  instructor: string;
  note: string;
};

export const EMPTY_STUDENT_META: StudentMeta = { label: "", group: "", instructor: "", note: "" };
export const REPORT_META_KEY = "cdt.report.meta.v1";

export type ViolationStat = {
  code: SimEventCode;
  clause: string;
  title: string;
  count: number;
  points: number;
  sharePct: number;
};

export type ScenarioStat = {
  scenarioId: ScenarioId;
  title: string;
  attempts: number;
  pass: number;
  fail: number;
  passRatePct: number;
  avgPoints: number;
  avgDurationSec: number;
  avgDistanceM: number;
};

export type AttemptReport = {
  schema: "cdt.report.v1";
  generatedAt: string;
  student: StudentMeta;
  rulesVersion: string;
  rulesStatus: RuleSet["status"];
  attempts: number;
  pass: number;
  fail: number;
  passRatePct: number;
  immediateFails: number;
  totalPoints: number;
  avgPoints: number;
  avgDurationSec: number;
  avgDistanceM: number;
  avgCollisions: number;
  violations: ViolationStat[];
  byScenario: ScenarioStat[];
  timeline: Array<{ i: number; verdict: string; points: number; scenarioId: ScenarioId }>;
  recommendations: string[];
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function buildRecommendations(args: {
  attempts: number;
  passRatePct: number;
  avgCollisions: number;
  violations: ViolationStat[];
}): string[] {
  const out: string[] = [];
  const has = (code: SimEventCode) => args.violations.some((v) => v.code === code);

  if (args.attempts < 3) {
    out.push("Попыток мало для устойчивых выводов — проведите ещё несколько заездов по каждому упражнению.");
  }
  if (args.avgCollisions >= 1) {
    out.push(
      `В среднем ${args.avgCollisions} касания за попытку: отработайте чувство габаритов на медленных манёврах задним ходом.`
    );
  }
  if (has("line_cross")) {
    out.push("Пересечение линий разметки: тренируйте заезд по дуге траектории (кнопка «Траектория») и ориентирам кузова.");
  }
  if (has("park_overspeed")) {
    out.push("Скорость задним ходом выше порога: паркуйтесь на минимальной тяге, тормоз S применяйте заблаговременно.");
  }
  if (has("no_turn_signal")) {
    out.push("Не подаётся указатель поворота: включайте сигнал до начала манёвра (Q — левый, E — правый).");
  }
  if (has("belt_unfastened")) {
    out.push("Ремень безопасности: пристёгивайтесь до запуска двигателя — это ошибка на 4 балла.");
  }
  if (has("pedestrian_yield")) {
    out.push("Пешеходные переходы: снижайте скорость заранее и пропускайте пешехода, находящегося на проезжей части.");
  }
  if (has("red_light_run") || has("stop_line_cross")) {
    out.push("Светофоры: останавливайтесь до стоп-линии 1.12 на запрещающий сигнал, без заезда передним габаритом.");
  }
  if (has("speed_limit")) {
    out.push("Скоростной режим маршрута: следите за знаками 3.24 и снижайте скорость до знака, а не на нём.");
  }
  if (args.attempts >= 3 && args.passRatePct >= 80) {
    out.push("Уровень готовности высокий: поддерживайте стабильность и добавьте заезды по городскому маршруту.");
  } else if (args.attempts >= 3 && args.passRatePct < 50) {
    out.push("Готовность ниже половины: разберите попытки в «Разбор и Реплей» и отработайте самые частые нарушения.");
  }
  if (out.length === 0) {
    out.push("Повторяющихся грубых нарушений не выявлено — продолжайте отработку упражнений по плану.");
  }
  return out.slice(0, 6);
}

/** Считает отчёт по журналу. Вердикты пересчитываются по ТЕКУЩЕМУ набору правил. */
export function buildAttemptReport(
  journal: readonly RecordedAttempt[],
  rules: RuleSet,
  student: StudentMeta
): AttemptReport {
  // Журнал хранит новые попытки первыми — для отчёта идём в хронологическом порядке
  const chronological = [...journal].reverse();

  let pass = 0;
  let fail = 0;
  let immediateFails = 0;
  let totalPoints = 0;
  let totalDuration = 0;
  let totalDistance = 0;
  let totalCollisions = 0;

  const violMap = new Map<SimEventCode, { count: number; points: number }>();
  const scenMap = new Map<
    ScenarioId,
    { title: string; attempts: number; pass: number; fail: number; points: number; duration: number; distance: number }
  >();
  const timeline: AttemptReport["timeline"] = [];

  chronological.forEach((attempt, i) => {
    const evaluation = evaluateAttempt(attempt.events, attempt.evaluation.collisions, rules);
    const ok = evaluation.verdict === "СДАЛ";
    if (ok) pass += 1;
    else fail += 1;
    if (evaluation.hasImmediateFail) immediateFails += 1;

    totalPoints += evaluation.totalPoints;
    totalDuration += attempt.durationSec;
    totalDistance += attempt.distanceMeters;
    totalCollisions += evaluation.collisions;

    for (const item of evaluation.items) {
      const cur = violMap.get(item.event.code) ?? { count: 0, points: 0 };
      cur.count += 1;
      cur.points += item.appliedPoints;
      violMap.set(item.event.code, cur);
    }

    const scenario =
      scenMap.get(attempt.scenarioId) ??
      {
        title: attempt.scenarioTitle,
        attempts: 0,
        pass: 0,
        fail: 0,
        points: 0,
        duration: 0,
        distance: 0,
      };
    scenario.attempts += 1;
    if (ok) scenario.pass += 1;
    else scenario.fail += 1;
    scenario.points += evaluation.totalPoints;
    scenario.duration += attempt.durationSec;
    scenario.distance += attempt.distanceMeters;
    scenMap.set(attempt.scenarioId, scenario);

    timeline.push({
      i: i + 1,
      verdict: evaluation.verdict,
      points: evaluation.totalPoints,
      scenarioId: attempt.scenarioId,
    });
  });

  const attempts = chronological.length;
  const totalItems = [...violMap.values()].reduce((sum, v) => sum + v.count, 0);

  const violations: ViolationStat[] = [...violMap.entries()]
    .map(([code, v]) => {
      const rule = rules.rules.find((r) => r.code === code);
      return {
        code,
        clause: rule?.clause ?? "—",
        title: rule?.title ?? String(code),
        count: v.count,
        points: v.points,
        sharePct: totalItems > 0 ? round1((v.count / totalItems) * 100) : 0,
      };
    })
    .sort((a, b) => b.count - a.count || b.points - a.points);

  const byScenario: ScenarioStat[] = [...scenMap.entries()]
    .map(([scenarioId, s]) => ({
      scenarioId,
      title: s.title,
      attempts: s.attempts,
      pass: s.pass,
      fail: s.fail,
      passRatePct: round1((s.pass / s.attempts) * 100),
      avgPoints: round1(s.points / s.attempts),
      avgDurationSec: round1(s.duration / s.attempts),
      avgDistanceM: round1(s.distance / s.attempts),
    }))
    .sort((a, b) => b.attempts - a.attempts);

  const args = {
    attempts,
    passRatePct: attempts > 0 ? (pass / attempts) * 100 : 0,
    avgCollisions: attempts > 0 ? totalCollisions / attempts : 0,
    violations,
  };

  return {
    schema: "cdt.report.v1",
    generatedAt: new Date().toISOString(),
    student,
    rulesVersion: rules.version,
    rulesStatus: rules.status,
    attempts,
    pass,
    fail,
    passRatePct: attempts > 0 ? round1(args.passRatePct) : 0,
    immediateFails,
    totalPoints,
    avgPoints: attempts > 0 ? round1(totalPoints / attempts) : 0,
    avgDurationSec: attempts > 0 ? round1(totalDuration / attempts) : 0,
    avgDistanceM: attempts > 0 ? round1(totalDistance / attempts) : 0,
    avgCollisions: attempts > 0 ? round1(totalCollisions / attempts) : 0,
    violations,
    byScenario,
    timeline,
    recommendations: buildRecommendations(args),
  };
}

const DISCLAIMER =
  "Учебная симуляция. Не заменяет практический экзамен в ГИБДД и не является нормативным документом.";

/** Markdown-отчёт для отправки в автошколу / вложения в журнал инструктора. */
export function reportToMarkdown(report: AttemptReport): string {
  const s = report.student;
  const lines: string[] = [];
  lines.push("# Отчёт по попыткам CityDrivingTraining");
  lines.push("");
  lines.push(
    `Ученик: ${s.label.trim() || "—"} · Группа: ${s.group.trim() || "—"} · Инструктор: ${s.instructor.trim() || "—"}`
  );
  lines.push(`Дата отчёта: ${report.generatedAt.slice(0, 10)} · Правила: ${report.rulesVersion} (${report.rulesStatus})`);
  if (s.note.trim()) lines.push(`Заметка: ${s.note.trim()}`);
  lines.push("");
  lines.push("## Сводка");
  lines.push("| Показатель | Значение |");
  lines.push("|---|---|");
  lines.push(`| Попыток | ${report.attempts} |`);
  lines.push(`| Сдал / Не сдал | ${report.pass} / ${report.fail} |`);
  lines.push(`| Доля сдачи | ${report.passRatePct} % |`);
  lines.push(`| Немедленных провалов (5 б.) | ${report.immediateFails} |`);
  lines.push(`| Средний штраф | ${report.avgPoints} б. |`);
  lines.push(`| Средняя длительность | ${report.avgDurationSec} с |`);
  lines.push(`| Средняя дистанция | ${report.avgDistanceM} м |`);
  lines.push(`| Средние касания | ${report.avgCollisions} |`);
  lines.push("");
  lines.push("## Нарушения");
  if (report.violations.length === 0) {
    lines.push("Не зафиксировано ни одного нарушения в активном наборе правил.");
  } else {
    lines.push("| Пункт | Нарушение | Раз | Баллы | Доля |");
    lines.push("|---|---|---|---|---|");
    for (const v of report.violations) {
      lines.push(`| ${v.clause} | ${v.title} | ${v.count} | ${v.points} | ${v.sharePct} % |`);
    }
  }
  lines.push("");
  lines.push("## По упражнениям");
  if (report.byScenario.length === 0) {
    lines.push("Нет данных.");
  } else {
    lines.push("| Упражнение | Попыток | Сдал | Не сдал | Сдача, % | Ср. штраф |");
    lines.push("|---|---|---|---|---|---|");
    for (const sc of report.byScenario) {
      lines.push(
        `| ${sc.title} | ${sc.attempts} | ${sc.pass} | ${sc.fail} | ${sc.passRatePct} | ${sc.avgPoints} б. |`
      );
    }
  }
  lines.push("");
  lines.push("## Рекомендации");
  for (const r of report.recommendations) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## Хронология");
  lines.push(
    report.timeline.map((t) => `#${t.i} ${t.verdict} (${t.points} б.)`).join(" · ") || "Нет данных."
  );
  lines.push("");
  lines.push("---");
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

function escapeCsv(value: string | number): string {
  const raw = String(value);
  if (/[;"\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** CSV всех попыток (разделитель «;» — открывается в Excel без настроек). */
export function attemptsToCsv(journal: readonly RecordedAttempt[], rules: RuleSet): string {
  const head = [
    "createdAt",
    "scenarioId",
    "scenarioTitle",
    "verdict",
    "points",
    "immediateFail",
    "durationSec",
    "distanceM",
    "collisions",
    "events",
    "rulesVersion",
    "checksum",
  ];
  const rows: string[] = [head.join(";")];
  for (const a of [...journal].reverse()) {
    const evaluation = evaluateAttempt(a.events, a.evaluation.collisions, rules);
    rows.push(
      [
        a.createdAt,
        a.scenarioId,
        a.scenarioTitle,
        evaluation.verdict,
        evaluation.totalPoints,
        evaluation.hasImmediateFail ? "1" : "0",
        a.durationSec,
        a.distanceMeters,
        evaluation.collisions,
        a.events.length,
        rules.version,
        attemptChecksum(a),
      ]
        .map(escapeCsv)
        .join(";")
    );
  }
  return rows.join("\n");
}

/** CSV агрегированных нарушений. */
export function violationsToCsv(report: AttemptReport): string {
  const rows: string[] = ["code;clause;title;count;points;sharePct"];
  for (const v of report.violations) {
    rows.push(
      [v.code, v.clause, v.title, v.count, v.points, v.sharePct].map(escapeCsv).join(";")
    );
  }
  return rows.join("\n");
}
