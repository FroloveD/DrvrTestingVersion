import { WHEEL_LOCK } from "../sim/vehicle";
import type { CalibrationConfig, SimEvent, SimEventCode } from "../sim/types";

export type RuleKind = "immediate" | "penalty";

export type ScoringRule = {
  code: SimEventCode;
  clause: string; // код пункта (демо-нумерация до сверки с инструктором)
  title: string;
  explanation: string;
  points: number;
  kind: RuleKind;
  enabled: boolean;
  category: "Грубые" | "Средние" | "Мелкие" | "Площадка";
};

export type RuleSet = {
  version: string;
  status: "unvalidated" | "instructor_signed";
  instructorSignOff: string;
  source: string;
  effectiveFrom: string;
  failThreshold: number;
  stopOnImmediateFail: boolean; // false = учебный режим (продолжаем ехать, фиксируя ошибку)
  rules: ScoringRule[];
};

export const DEFAULT_CALIBRATION: CalibrationConfig = {
  maxInnerWheelDeg: WHEEL_LOCK.defaultDeg,
  perpBayWidth: 2.5,
  perpBayLength: 5.3, // v8: 5.3 м; в README: 5.5 м — переключается в редакторе
  aisleWidth: 6.0,
  parBayLength: 6.0, // перенос из v2 (PAR)
  parBayWidth: 2.2, // перенос из v2 (PAR)
  holdDurationSec: 1.5,
  maxParkSpeedKmh: 10,
  showLearnerSign: true,
};

export const DEFAULT_RULESET: RuleSet = {
  version: "ru-demo-0.2.0",
  status: "unvalidated",
  instructorSignOff: "",
  source: "Демо-профиль по структуре экзаменационного листа — требует сверки с действующим регламентом МВД и подписи инструктора",
  effectiveFrom: "2026-01-01",
  failThreshold: 5,
  stopOnImmediateFail: false,
  rules: [
    {
      code: "collision",
      clause: "Д-1.1",
      title: "Наезд на препятствие, бордюр или припаркованное ТС",
      explanation: "Создание аварийной ситуации / наезд на разметочное оборудование или бордюр прекращает экзамен.",
      points: 5,
      kind: "immediate",
      enabled: true,
      category: "Грубые",
    },
    {
      code: "line_cross",
      clause: "Д-1.2",
      title: "Пересечение сплошной линии разметки парковочного места",
      explanation: "Габарит кузова вышел за боковую или торцевую границу бокса при манёвре.",
      points: 5,
      kind: "immediate",
      enabled: true,
      category: "Площадка",
    },
    {
      code: "red_light_run",
      clause: "Д-1.3",
      title: "Проезд на запрещающий сигнал светофора",
      explanation: "Выезд за стоп-линию и движение через перекрёсток при красном или жёлтом сигнале светофора.",
      points: 5,
      kind: "immediate",
      enabled: true,
      category: "Грубые",
    },
    {
      code: "stop_line_cross",
      clause: "Д-1.4",
      title: "Пересечение стоп-линии (1.12) при запрещающем сигнале",
      explanation: "Передний габарит автомобиля пересёк стоп-линию при красном/жёлтом сигнале.",
      points: 5,
      kind: "immediate",
      enabled: true,
      category: "Грубые",
    },
    {
      code: "pedestrian_yield",
      clause: "Д-1.5",
      title: "Не уступил дорогу пешеходу на переходе",
      explanation: "Проезд нерегулируемого пешеходного перехода без остановки, когда пешеход находился на проезжей части.",
      points: 5,
      kind: "immediate",
      enabled: true,
      category: "Грубые",
    },
    {
      code: "speed_limit",
      clause: "Д-1.6",
      title: "Превышение установленной скорости движения",
      explanation: "Скорость автомобиля превысила ограничение дорожного знака на данном участке маршрута.",
      points: 5,
      kind: "immediate",
      enabled: true,
      category: "Грубые",
    },
    {
      code: "belt_unfastened",
      clause: "Д-2.1",
      title: "Начало движения с непристёгнутым ремнём безопасности",
      explanation: "Перед началом движения пристегните ремень безопасности (клавиша B).",
      points: 4,
      kind: "penalty",
      enabled: true,
      category: "Средние",
    },
    {
      code: "extra_reverse",
      clause: "Д-2.2",
      title: "Повторное включение передачи заднего хода при парковке",
      explanation: "Постановка автомобиля в бокс должна выполняться с однократным (или согласованным) включением R.",
      points: 3,
      kind: "penalty",
      enabled: true,
      category: "Площадка",
    },
    {
      code: "neutral_after_stop",
      clause: "Д-2.3",
      title: "Не зафиксировал ТС (P/N + стояночный тормоз) после парковки",
      explanation: "После постановки в бокс включите P (или N), затяните стояночный тормоз (Space).",
      points: 3,
      kind: "penalty",
      enabled: false, // включается по желанию инструктора в редакторе
      category: "Площадка",
    },
    {
      code: "park_overspeed",
      clause: "Д-3.1",
      title: "Превышена безопасная скорость маневрирования задним ходом",
      explanation: "При заезде в бокс или параллельной парковке держите плавную скорость (до порога инструктора).",
      points: 2,
      kind: "penalty",
      enabled: true,
      category: "Площадка",
    },
    {
      code: "no_turn_signal",
      clause: "Д-4.1",
      title: "Не подан указатель поворота перед началом движения / манёвром",
      explanation: "Включайте левый (Q) или правый (E) поворотник заблаговременно перед началом движения и поворотом.",
      points: 1,
      kind: "penalty",
      enabled: true,
      category: "Мелкие",
    },
    {
      code: "harsh_brake",
      clause: "Д-4.2",
      title: "Резкое торможение без необходимости предотвращения ДТП",
      explanation: "Снижайте скорость заблаговременно и плавно.",
      points: 1,
      kind: "penalty",
      enabled: false,
      category: "Мелкие",
    },
  ],
};

export type EvaluatedItem = {
  event: SimEvent;
  rule: ScoringRule;
  appliedPoints: number;
  immediate: boolean;
};

export type EvaluationResult = {
  verdict: "СДАЛ" | "НЕ СДАЛ";
  totalPoints: number;
  failThreshold: number;
  hasImmediateFail: boolean;
  items: EvaluatedItem[];
  rulesVersion: string;
  rulesStatus: RuleSet["status"];
  legacyV8Score: number; // Math.max(0, 100 - 15 * collisions) — для сравнения с монолитом v8
  collisions: number;
};

/** Чистая функция подсчёта результата попытки по событиям и активному набору правил. */
export function evaluateAttempt(
  events: readonly SimEvent[],
  collisions: number,
  ruleSet: RuleSet
): EvaluationResult {
  const ruleMap = new Map<SimEventCode, ScoringRule>();
  for (const r of ruleSet.rules) {
    if (r.enabled) ruleMap.set(r.code, r);
  }

  const items: EvaluatedItem[] = [];
  let totalPoints = 0;
  let hasImmediateFail = false;

  for (const ev of events) {
    const rule = ruleMap.get(ev.code);
    if (!rule) continue;
    const immediate = rule.kind === "immediate";
    if (immediate) hasImmediateFail = true;
    totalPoints += rule.points;
    items.push({
      event: ev,
      rule,
      appliedPoints: rule.points,
      immediate,
    });
  }

  const failed = hasImmediateFail || totalPoints >= ruleSet.failThreshold;
  return {
    verdict: failed ? "НЕ СДАЛ" : "СДАЛ",
    totalPoints,
    failThreshold: ruleSet.failThreshold,
    hasImmediateFail,
    items,
    rulesVersion: ruleSet.version,
    rulesStatus: ruleSet.status,
    legacyV8Score: Math.max(0, 100 - 15 * collisions),
    collisions,
  };
}
