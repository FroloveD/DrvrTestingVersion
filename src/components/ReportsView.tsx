import { useEffect, useMemo, useRef, useState } from "react";
import { buildParallelScenario, buildPerpendicularScenario } from "../scenarios/catalog";
import {
  customFromWorld,
  defaultCustomScenario,
  type CustomScenarioDef,
} from "../scenarios/custom";
import type { RuleSet } from "../scoring/rules";
import {
  attemptsToCsv,
  buildAttemptReport,
  EMPTY_STUDENT_META,
  REPORT_META_KEY,
  reportToMarkdown,
  violationsToCsv,
  type StudentMeta,
} from "../stats/report";
import type { RecordedAttempt } from "../sim/recorder";
import type { CalibrationConfig } from "../sim/types";
import { Chip, CopyButton, downloadJson, downloadTextFile, Icon } from "./Icons";

type Props = {
  journal: RecordedAttempt[];
  ruleSet: RuleSet;
  calibration: CalibrationConfig;
  onImportAsCustomScenario: (def: CustomScenarioDef) => void;
  onBackToSim: () => void;
  onNotify: (msg: string) => void;
};

function loadMeta(): StudentMeta {
  try {
    const raw = localStorage.getItem(REPORT_META_KEY);
    if (!raw) return EMPTY_STUDENT_META;
    return { ...EMPTY_STUDENT_META, ...(JSON.parse(raw) as Partial<StudentMeta>) };
  } catch {
    return EMPTY_STUDENT_META;
  }
}

function saveMeta(meta: StudentMeta): void {
  try {
    localStorage.setItem(REPORT_META_KEY, JSON.stringify(meta));
  } catch {
    // storage blocked
  }
}

function MetaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mono text-[10px] text-[#7c909d] block mb-1">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
      />
    </label>
  );
}

export function ReportsView({
  journal,
  ruleSet,
  calibration,
  onImportAsCustomScenario,
  onBackToSim,
  onNotify,
}: Props) {
  const [meta, setMeta] = useState<StudentMeta>(loadMeta);
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    saveMeta(meta);
  }, [meta]);

  const report = useMemo(() => buildAttemptReport(journal, ruleSet, meta), [journal, ruleSet, meta]);

  const maxShare = report.violations.reduce((m, v) => Math.max(m, v.sharePct), 0);

  const importTemplates = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<CustomScenarioDef>;
      if (!parsed || !Array.isArray(parsed.bays) || !Array.isArray(parsed.obstacles) || !parsed.start) {
        throw new Error("Неверная схема файла сценария (нужны bays, obstacles, start)");
      }
      const def: CustomScenarioDef = { ...defaultCustomScenario(), ...parsed, version: 1 };
      onImportAsCustomScenario(def);
      onNotify(`Сценарий «${def.title}» загружен — откройте «Свой сценарий»`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось прочитать файл сценария");
    }
  };

  if (journal.length === 0) {
    return (
      <div className="panel p-8 text-center max-w-2xl mx-auto my-8">
        <div className="inline-grid place-items-center h-12 w-12 rounded-2xl bg-[#f5b942]/15 text-[#f5b942] mb-4">
          <Icon name="chart" size={22} />
        </div>
        <h2 className="text-2xl font-extrabold mb-2">Отчёт для автошколы</h2>
        <p className="text-[13px] text-[#9bafbc] leading-relaxed mb-6">
          Здесь появится статистика по ученику: доля сдачи, средний штраф, самые частые нарушения,
          разбивка по упражнениям и рекомендации инструктору. Проедьте несколько попыток в тренажёре —
          журнал заполняется автоматически.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <button type="button" className="btn btn-primary" onClick={onBackToSim}>
            <Icon name="car" size={15} /> Перейти в 3D-тренажёр
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMeta(EMPTY_STUDENT_META);
              onNotify("Поля отчёта очищены");
            }}
          >
            <Icon name="reset" size={13} /> Очистить поля отчёта
          </button>
        </div>
      </div>
    );
  }

  const kpi = [
    { label: "ПОПЫТОК", value: String(report.attempts), tone: "text-[#e9f1f5]" },
    {
      label: "ДОЛЯ СДАЧИ",
      value: `${report.passRatePct}%`,
      tone: report.passRatePct >= 80 ? "text-[#52d6bd]" : report.passRatePct >= 50 ? "text-[#f5b942]" : "text-[#ff6b6b]",
    },
    { label: "СРЕДНИЙ ШТРАФ", value: `${report.avgPoints} б.`, tone: "text-[#f5b942]" },
    {
      label: "ГРУБЫХ ПРОВАЛОВ",
      value: String(report.immediateFails),
      tone: report.immediateFails > 0 ? "text-[#ff6b6b]" : "text-[#52d6bd]",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Отчёт как артефакт</Chip>
            <Chip tone={report.rulesStatus === "instructor_signed" ? "mint" : "red"}>
              правила {report.rulesVersion} ({report.rulesStatus === "instructor_signed" ? "подписаны" : "unvalidated"})
            </Chip>
            <Chip tone="neutral">{report.attempts} попыток</Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Статистика по ученику</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1">
            Вердикты пересчитаны по текущему набору правил — отчёт всегда согласован с калибровкой инструктора.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={reportToMarkdown(report)} label="Копировать MD" onDone={onNotify} />
          <button
            type="button"
            className="btn btn-mini"
            onClick={() =>
              downloadTextFile(
                `report-${report.generatedAt.slice(0, 10)}.md`,
                reportToMarkdown(report),
                "text/markdown;charset=utf-8",
                onNotify
              )
            }
          >
            <Icon name="download" size={13} /> report.md
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() =>
              downloadTextFile(
                `attempts-${report.generatedAt.slice(0, 10)}.csv`,
                attemptsToCsv(journal, ruleSet),
                "text/csv;charset=utf-8",
                onNotify,
                true
              )
            }
          >
            <Icon name="download" size={13} /> attempts.csv
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() =>
              downloadTextFile(
                `violations-${report.generatedAt.slice(0, 10)}.csv`,
                violationsToCsv(report),
                "text/csv;charset=utf-8",
                onNotify,
                true
              )
            }
          >
            <Icon name="download" size={13} /> violations.csv
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() =>
              downloadJson(`report-${report.generatedAt.slice(0, 10)}.json`, report, onNotify)
            }
          >
            <Icon name="download" size={13} /> JSON
          </button>
          <button type="button" className="btn btn-primary btn-mini" onClick={onBackToSim}>
            <Icon name="car" size={13} /> К заездам
          </button>
        </div>
      </div>

      {/* Данные ученика: минимум персональных данных, хранится только в браузере */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="text-xs font-extrabold">Подписи для отчёта (необязательно)</div>
          <Chip tone="mint">хранится только в браузере</Chip>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <MetaField label="УЧЕНИК" value={meta.label} placeholder="Фамилия и инициалы" onChange={(v) => setMeta({ ...meta, label: v })} />
          <MetaField label="ГРУППА" value={meta.group} placeholder="Напр. B-2026-12" onChange={(v) => setMeta({ ...meta, group: v })} />
          <MetaField label="ИНСТРУКТОР" value={meta.instructor} placeholder="ФИО инструктора" onChange={(v) => setMeta({ ...meta, instructor: v })} />
          <MetaField label="ЗАМЕТКА" value={meta.note} placeholder="Особые условия заезда" onChange={(v) => setMeta({ ...meta, note: v })} />
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpi.map((k) => (
          <div key={k.label} className="panel p-4">
            <div className="mono text-[10px] text-[#7c909d]">{k.label}</div>
            <div className={`mono text-3xl font-bold mt-1.5 ${k.tone}`}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-4 items-start">
        {/* Диаграмма нарушений */}
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs font-extrabold">Самые частые нарушения</div>
            <span className="mono text-[10px] text-[#7c909d]">доля от всех зафиксированных</span>
          </div>
          {report.violations.length === 0 ? (
            <div className="panel-soft p-4 text-[12px] text-[#52d6bd]">
              Нарушений нет — все попытки чистые по активному набору правил.
            </div>
          ) : (
            <div className="space-y-3">
              {report.violations.map((v) => (
                <div key={v.code}>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="mono text-[10px] text-[#f5b942]">{v.clause}</span>
                    <span className="text-[12px] font-semibold text-[#d3e0e7] truncate">{v.title}</span>
                    <span className="mono text-[11px] text-[#8fa2ae] ml-auto whitespace-nowrap">
                      {v.count}× · {v.points} б. · {v.sharePct}%
                    </span>
                  </div>
                  <div className="h-2 rounded bg-[rgba(148,176,194,.12)] overflow-hidden">
                    <div
                      className="h-full rounded bg-gradient-to-r from-[#ff6b6b] to-[#f5b942]"
                      style={{ width: `${maxShare > 0 ? (v.sharePct / maxShare) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 pt-4 border-t hairline">
            <div className="text-xs font-extrabold mb-2.5">Хронология попыток</div>
            <div className="flex flex-wrap gap-1.5">
              {report.timeline.map((t) => (
                <span
                  key={t.i}
                  title={`Попытка #${t.i}: ${t.verdict}, ${t.points} б.`}
                  className={`mono text-[10px] px-2 py-1 rounded-md border ${
                    t.verdict === "СДАЛ"
                      ? "bg-[#52d6bd]/12 border-[#52d6bd]/40 text-[#52d6bd]"
                      : "bg-[#ff6b6b]/12 border-[#ff6b6b]/45 text-[#ff9494]"
                  }`}
                >
                  #{t.i}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* По упражнениям + рекомендации */}
        <div className="space-y-4">
          <div className="panel p-5">
            <div className="text-xs font-extrabold mb-3">По упражнениям</div>
            <div className="space-y-2.5">
              {report.byScenario.map((sc) => (
                <div key={sc.scenarioId} className="panel-soft p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[12px] font-bold text-[#e9f1f5] truncate">{sc.title}</span>
                    <Chip tone={sc.passRatePct >= 80 ? "mint" : sc.passRatePct >= 50 ? "amber" : "red"}>
                      {sc.passRatePct}%
                    </Chip>
                  </div>
                  <div className="mono text-[10px] text-[#8fa2ae]">
                    попыток {sc.attempts} · сдал {sc.pass} / не сдал {sc.fail} · ср. штраф {sc.avgPoints} б. ·{" "}
                    {sc.avgDurationSec} с · {sc.avgDistanceM} м
                  </div>
                  <div className="h-1.5 rounded bg-[rgba(148,176,194,.12)] mt-2 overflow-hidden">
                    <div className="h-full rounded bg-[#52d6bd]" style={{ width: `${sc.passRatePct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="flex items-center gap-2 text-xs font-extrabold mb-3">
              <Icon name="spark" size={14} className="text-[#f5b942]" />
              Рекомендации инструктору
            </div>
            <div className="space-y-2">
              {report.recommendations.map((r, i) => (
                <div key={i} className="flex gap-2 text-[12px] leading-relaxed text-[#d3e0e7]">
                  <span className="mono text-[#f5b942] shrink-0">{i + 1}.</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Markdown-отчёт + шаблоны сценариев для слабых групп */}
      <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-4 items-start">
        <div className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-xs font-extrabold">Готовый Markdown-отчёт</div>
            <span className="mono text-[10px] text-[#7c909d]">cdt.report.v1</span>
          </div>
          <pre className="mono text-[10.5px] leading-[1.7] text-[#b9c9d3] panel-soft p-3 overflow-x-auto scroll-thin whitespace-pre-wrap max-h-[320px]">
            {reportToMarkdown(report)}
          </pre>
        </div>

        <div className="panel p-5">
          <div className="text-xs font-extrabold mb-2">Материал для отработки</div>
          <p className="text-[11px] text-[#9bafbc] mb-3">
            По самому частому нарушению можно быстро собрать дополнительную площадку: скопировать
            упражнение в «Свой сценарий» и упростить или усложнить его.
          </p>
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                onImportAsCustomScenario(customFromWorld(buildPerpendicularScenario(calibration), "Отработка: бокс 90°"));
                onNotify("Скопировано в «Свой сценарий»");
              }}
            >
              + Копия: Бокс 90°
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                onImportAsCustomScenario(customFromWorld(buildParallelScenario(calibration), "Отработка: параллельная"));
                onNotify("Скопировано в «Свой сценарий»");
              }}
            >
              + Копия: Параллельная
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={importTemplates}
            />
            <button type="button" className="btn btn-mini" onClick={() => importRef.current?.click()}>
              <Icon name="upload" size={12} /> Свой scenario.json
            </button>
          </div>
          <div className="panel-soft p-3 text-[11px] leading-relaxed text-[#8fa2ae]">
            Персональные данные ограничены подписями ученика, группы и инструктора. В CSV попадают только
            метрики попыток, дата и контрольная сумма — без файлов сцены и без передачи на сервер.
          </div>
        </div>
      </div>
    </div>
  );
}
