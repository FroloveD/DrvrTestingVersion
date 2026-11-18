import { useRef } from "react";
import {
  DEFAULT_CALIBRATION,
  DEFAULT_RULESET,
  type RuleKind,
  type RuleSet,
} from "../scoring/rules";
import type { CalibrationConfig } from "../sim/types";
import { CAR, centralSteerLimit, normalizeWheelLock, outerTurningRadius } from "../sim/vehicle";
import { Chip, CopyButton, downloadJson, Icon } from "./Icons";
import { SteeringLimitControl } from "./SteeringLimitControl";

type Props = {
  ruleSet: RuleSet;
  onRuleSetChange: (next: RuleSet) => void;
  calibration: CalibrationConfig;
  onCalibrationChange: (next: CalibrationConfig) => void;
  onNotify: (msg: string) => void;
};

export function InstructorEditorView({
  ruleSet,
  onRuleSetChange,
  calibration,
  onCalibrationChange,
  onNotify,
}: Props) {
  const importRef = useRef<HTMLInputElement | null>(null);
  const minOuterR = outerTurningRadius(centralSteerLimit(calibration.maxInnerWheelDeg));

  const instructorProtocolMd = `# Протокол сверки критериев CityDrivingTraining с инструктором
Дата: ____________  Инструктор / автошкола: ________________________
Нормативный документ (редакция): ___________________________________
Старт попытки: ДВС заглушен, КПП в P (Parking), ручник затянут → подтвердить: [ ] Да [ ] Нет

## 1. Геометрия упражнений (для ${CAR.model}: ${CAR.length} × ${CAR.width} м, Rвнеш ≈ ${minOuterR.toFixed(2)} м)
- Предел внутреннего переднего колеса: ${normalizeWheelLock(calibration.maxInnerWheelDeg)}° (полный ход руля ±540°).
- Перпендикулярный бокс 90°: сейчас ${calibration.perpBayWidth} × ${calibration.perpBayLength} м (в v8: 2.5×5.3, в README: 2.5×5.5) → утвердить: ______
- Ширина проезда перед боксом: сейчас ${calibration.aisleWidth} м → утвердить: ______
- Параллельный карман: сейчас ${calibration.parBayLength} × ${calibration.parBayWidth} м → утвердить: ______
- Время фиксации остановки: сейчас ${calibration.holdDurationSec} с; нужна ли фиксация P (или N) + ручник? [ ] Да [ ] Нет
- Рекомендуемая макс. скорость задним ходом: сейчас ${calibration.maxParkSpeedKmh} км/ч → утвердить: ______

## 2. Таблица штрафных баллов (порог «НЕ СДАЛ»: ${ruleSet.failThreshold} б., версия ${ruleSet.version})
${ruleSet.rules
  .map(
    (r) =>
      `- [${r.enabled ? "x" : " "}] ${r.clause} ${r.title}: ${r.points} б. (${
        r.kind === "immediate" ? "прекращение" : "штраф"
      }) → комментарий: ____`
  )
  .join("\n")}

Подпись инструктора: ___________________
`;

  const updateRule = (idx: number, patch: Partial<RuleSet["rules"][number]>) => {
    const nextRules = ruleSet.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onRuleSetChange({ ...ruleSet, rules: nextRules });
  };

  const handleImportRules = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<RuleSet>;
      if (!parsed || !Array.isArray(parsed.rules) || typeof parsed.failThreshold !== "number") {
        throw new Error("Неверная схема rules.json");
      }
      onRuleSetChange({
        ...DEFAULT_RULESET,
        ...parsed,
        rules: parsed.rules,
      });
      onNotify(`Загружен профиль правил ${parsed.version || file.name}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось прочитать rules.json");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Правила и геометрия как данные</Chip>
            <Chip tone={ruleSet.status === "instructor_signed" ? "mint" : "red"}>
              {ruleSet.status === "instructor_signed" ? "Подписано инструктором" : "Статус: unvalidated"}
            </Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Кабинет инструктора: калибровка и штрафы</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1">
            Любое изменение сразу применяется в 3D-тренажёре и пересчитывает протокол разбора — без правки кода.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportRules} />
          <button type="button" className="btn btn-mini" onClick={() => importRef.current?.click()}>
            <Icon name="upload" size={13} /> Импорт rules.json
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => downloadJson(`rules.${ruleSet.version}.json`, ruleSet, onNotify)}
          >
            <Icon name="download" size={13} /> Скачать rules.json
          </button>
          <CopyButton text={instructorProtocolMd} label="Протокол для инструктора" onDone={onNotify} />
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              onRuleSetChange(DEFAULT_RULESET);
              onCalibrationChange(DEFAULT_CALIBRATION);
              onNotify("Восстановлены значения по умолчанию");
            }}
          >
            <Icon name="reset" size={13} /> Сброс
          </button>
        </div>
      </div>

      {/* Калибровка размеров боксов (закрывает расхождение 5.3 м в v8 vs 5.5 м в README) */}
      <div className="grid lg:grid-cols-[1.05fr_.95fr] gap-4">
        <div className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs font-extrabold">Геометрия парковочных мест (BAY, AISLE, PAR)</div>
              <Chip tone="amber">значения предварительные</Chip>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className="btn btn-mini"
                onClick={() =>
                  onCalibrationChange({
                    ...calibration,
                    perpBayWidth: 2.5,
                    perpBayLength: 5.3,
                    aisleWidth: 6.0,
                  })
                }
              >
                Код v8 (2.5×5.3)
              </button>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() =>
                  onCalibrationChange({
                    ...calibration,
                    perpBayWidth: 2.5,
                    perpBayLength: 5.5,
                    aisleWidth: 6.0,
                  })
                }
              >
                README (2.5×5.5)
              </button>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() =>
                  onCalibrationChange({
                    ...calibration,
                    perpBayWidth: 2.8,
                    perpBayLength: 5.6,
                    aisleWidth: 6.8,
                    parBayLength: 6.6,
                    parBayWidth: 2.4,
                  })
                }
              >
                Новичок (шире)
              </button>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 text-[12px]">
            {[
              {
                label: "Ширина бокса 90°",
                key: "perpBayWidth" as const,
                min: 2.2,
                max: 3.4,
                step: 0.1,
                unit: "м",
                hint: `Зазор по бортам: ${((calibration.perpBayWidth - CAR.width) * 50).toFixed(0)} см с каждой стороны`,
              },
              {
                label: "Длина бокса 90°",
                key: "perpBayLength" as const,
                min: 4.8,
                max: 6.5,
                step: 0.1,
                unit: "м",
                hint: `Запас по длине: ${(calibration.perpBayLength - CAR.length).toFixed(2)} м`,
              },
              {
                label: "Ширина проезда (AISLE)",
                key: "aisleWidth" as const,
                min: 5.0,
                max: 8.5,
                step: 0.2,
                unit: "м",
                hint: `Внешний радиус Kia Ceed: ${minOuterR.toFixed(2)} м`,
              },
              {
                label: "Длина паралл. кармана",
                key: "parBayLength" as const,
                min: 5.4,
                max: 7.5,
                step: 0.1,
                unit: "м",
                hint: `Порт v2 = 6.0 м (запас ${(calibration.parBayLength - CAR.length).toFixed(2)} м)`,
              },
              {
                label: "Ширина паралл. кармана",
                key: "parBayWidth" as const,
                min: 2.0,
                max: 2.8,
                step: 0.1,
                unit: "м",
                hint: `Порт v2 = 2.2 м (кузов ${CAR.width} м)`,
              },
              {
                label: "Порог скорости в R",
                key: "maxParkSpeedKmh" as const,
                min: 5,
                max: 18,
                step: 1,
                unit: "км/ч",
                hint: `Фиксация остановки: ${calibration.holdDurationSec.toFixed(1)} с`,
              },
            ].map((item) => (
              <label key={item.key} className="panel-soft p-3 block">
                <div className="flex justify-between mb-1.5">
                  <span className="font-semibold text-[#d3e0e7]">{item.label}</span>
                  <span className="mono text-[#f5b942] font-bold">
                    {calibration[item.key]} {item.unit}
                  </span>
                </div>
                <input
                  type="range"
                  min={item.min}
                  max={item.max}
                  step={item.step}
                  value={calibration[item.key]}
                  onChange={(e) =>
                    onCalibrationChange({ ...calibration, [item.key]: Number(e.target.value) })
                  }
                  className="w-full"
                />
                <div className="mono text-[10px] text-[#7c909d] mt-1">{item.hint}</div>
              </label>
            ))}
          </div>

          <div className="mt-4">
            <SteeringLimitControl value={calibration.maxInnerWheelDeg} onChange={(angle) => onCalibrationChange({ ...calibration, maxInnerWheelDeg: angle })} />
          </div>

          <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t hairline text-[12px]">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={calibration.showLearnerSign}
                onChange={(e) => onCalibrationChange({ ...calibration, showLearnerSign: e.target.checked })}
              />
              <span>Табличка «У» на крыше автомобиля игрока (порт v2)</span>
            </label>
            <button
              type="button"
              className="btn btn-mini ml-auto"
              onClick={() => downloadJson("calibration.json", calibration, onNotify)}
            >
              <Icon name="download" size={12} /> calibration.json
            </button>
          </div>
        </div>

        {/* Паспорт набора правил и подпись инструктора */}
        <div className="panel p-5 flex flex-col gap-3">
          <div className="text-xs font-extrabold">Паспорт набора правил (метаданные ADR)</div>
          <div className="grid sm:grid-cols-2 gap-3 text-[12px]">
            <label className="block">
              <span className="mono text-[10px] text-[#7c909d] block mb-1">ВЕРСИЯ ПРАВИЛ</span>
              <input
                type="text"
                value={ruleSet.version}
                onChange={(e) => onRuleSetChange({ ...ruleSet, version: e.target.value })}
                className="w-full rounded-lg bg-[#091017] border hairline px-3 py-2 mono text-xs text-white"
              />
            </label>
            <label className="block">
              <span className="mono text-[10px] text-[#7c909d] block mb-1">ПОРОГ «НЕ СДАЛ» (БАЛЛОВ)</span>
              <input
                type="number"
                min={1}
                max={20}
                value={ruleSet.failThreshold}
                onChange={(e) =>
                  onRuleSetChange({ ...ruleSet, failThreshold: Math.max(1, Number(e.target.value) || 5) })
                }
                className="w-full rounded-lg bg-[#091017] border hairline px-3 py-2 mono text-xs text-[#f5b942]"
              />
            </label>
          </div>

          <label className="block text-[12px]">
            <span className="mono text-[10px] text-[#7c909d] block mb-1">НОРМАТИВНЫЙ ИСТОЧНИК И ДАТА</span>
            <input
              type="text"
              value={ruleSet.source}
              onChange={(e) => onRuleSetChange({ ...ruleSet, source: e.target.value })}
              className="w-full rounded-lg bg-[#091017] border hairline px-3 py-2 text-xs text-[#d3e0e7]"
            />
          </label>

          <div className="grid sm:grid-cols-2 gap-3 text-[12px]">
            <label className="block">
              <span className="mono text-[10px] text-[#7c909d] block mb-1">ФИО ИНСТРУКТОРА (ПОДПИСЬ)</span>
              <input
                type="text"
                placeholder="Напр.: Иванов И.И., АШ «Старт»"
                value={ruleSet.instructorSignOff}
                onChange={(e) => {
                  const name = e.target.value;
                  onRuleSetChange({
                    ...ruleSet,
                    instructorSignOff: name,
                    status: name.trim().length > 2 ? "instructor_signed" : "unvalidated",
                  });
                }}
                className="w-full rounded-lg bg-[#091017] border hairline px-3 py-2 text-xs text-white"
              />
            </label>
            <label className="block">
              <span className="mono text-[10px] text-[#7c909d] block mb-1">ДАТА АКТУАЛИЗАЦИИ</span>
              <input
                type="date"
                value={ruleSet.effectiveFrom}
                onChange={(e) => onRuleSetChange({ ...ruleSet, effectiveFrom: e.target.value })}
                className="w-full rounded-lg bg-[#091017] border hairline px-3 py-2 mono text-xs text-white"
              />
            </label>
          </div>

          <label className="panel-soft p-3 flex items-start gap-2.5 cursor-pointer text-[12px] mt-auto">
            <input
              type="checkbox"
              checked={ruleSet.stopOnImmediateFail}
              onChange={(e) => onRuleSetChange({ ...ruleSet, stopOnImmediateFail: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              <b className="text-[#e9f1f5] block">Строгий экзаменационный режим</b>
              <span className="text-[11px] text-[#8fa2ae]">
                Мгновенно останавливать автомобиль при первой грубой ошибке (immediate). В учебном режиме ошибка
                фиксируется, но ученик может завершить манёвр.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* Таблица правил оценки */}
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-extrabold">Критерии оценки ({ruleSet.rules.filter((r) => r.enabled).length} активных)</div>
          <span className="mono text-[10px] text-[#7c909d]">src/scoring/rules.ts → экспорт в JSON</span>
        </div>
        <div className="grid md:grid-cols-2 gap-2.5">
          {ruleSet.rules.map((r, idx) => (
            <div
              key={r.code}
              className={`panel-soft p-3 flex flex-col gap-2 transition ${
                r.enabled ? "" : "opacity-55"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => updateRule(idx, { enabled: e.target.checked })}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="mono text-[10px] text-[#f5b942]">{r.clause}</span>
                    <span className="mono text-[10px] text-[#6e8492]">{r.code}</span>
                  </div>
                  <div className="text-[12px] font-bold leading-snug mt-0.5">{r.title}</div>
                  <div className="text-[11px] text-[#8fa2ae] mt-0.5">{r.explanation}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-6 pt-1 border-t hairline text-[11px]">
                <span className="text-[#8fa2ae]">Баллы:</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={r.points}
                  onChange={(e) => updateRule(idx, { points: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                  className="w-14 rounded bg-[#091017] border hairline px-2 py-0.5 mono text-xs text-[#f5b942]"
                />
                <select
                  value={r.kind}
                  onChange={(e) => updateRule(idx, { kind: e.target.value as RuleKind })}
                  className="ml-auto rounded bg-[#091017] border hairline px-2 py-0.5 text-[11px] text-[#d3e0e7]"
                >
                  <option value="immediate">Прекращение экзамена</option>
                  <option value="penalty">Накопительный штраф</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
