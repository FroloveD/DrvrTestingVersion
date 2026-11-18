import { useMemo, useState } from "react";
import {
  MIN_REVIEWS_FOR_VERDICT,
  summarizeAgreement,
  type AgreementStatus,
  type AgreementSummary,
} from "../analytics/calibration";
import { attemptsToCsv, studentOf, summarizeAttempts, UNKNOWN_STUDENT } from "../analytics/summary";
import { evaluateAttempt, type RuleSet } from "../scoring/rules";
import type { AttemptMeta } from "../sim/journal";
import type { JournalBackend } from "../storage/journalStore";
import { Chip, downloadJson, Icon } from "./Icons";

type Props = {
  journal: AttemptMeta[];
  journalLimit: number;
  storageReady: boolean;
  storageBackend: JournalBackend;
  storageError: string | null;
  ruleSet: RuleSet;
  activeStudent: string;
  onActiveStudentChange: (name: string) => void;
  onSelectAttempt: (a: AttemptMeta) => void;
  onUpdateStudent: (attemptId: string, student: string) => void;
  onClearJournal: () => void;
  onOpenSimulator: () => void;
  onNotify: (msg: string) => void;
};

function downloadCsv(filename: string, csv: string): void {
  // BOM нужен, чтобы Excel корректно открыл кириллицу
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function Kpi({
  label,
  value,
  hint,
  tone = "text-[#f5b942]",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
}) {
  return (
    <div className="panel p-4">
      <div className="mono text-[10px] text-[#7c909d] mb-1">{label}</div>
      <div className={`mono text-2xl font-extrabold ${tone}`}>{value}</div>
      <div className="text-[10px] text-[#8fa2ae] mt-1 leading-snug">{hint}</div>
    </div>
  );
}

const STATUS_TONE: Record<AgreementStatus, "neutral" | "amber" | "red" | "mint"> = {
  no_data: "neutral",
  insufficient: "amber",
  below_target: "red",
  meets_target: "mint",
};

/** Число оканчивается на 1, но не на 11: «из 1 оценки», «по 21 заезду». */
function isOne(n: number): boolean {
  return n % 10 === 1 && n % 100 !== 11;
}

function statusLabel(s: AgreementSummary): string {
  switch (s.status) {
    case "no_data":
      return "оценок нет";
    case "insufficient":
      return `мало данных: ${s.reviews} из ${s.minReviews}`;
    case "below_target":
      return `ниже цели ${s.target}%`;
    case "meets_target":
      return `цель ${s.target}% достигнута`;
  }
}

export function AnalyticsView({
  journal,
  journalLimit,
  storageReady,
  storageBackend,
  storageError,
  ruleSet,
  activeStudent,
  onActiveStudentChange,
  onSelectAttempt,
  onUpdateStudent,
  onClearJournal,
  onOpenSimulator,
  onNotify,
}: Props) {
  const [studentFilter, setStudentFilter] = useState<string>("all");
  const [scenarioFilter, setScenarioFilter] = useState<string>("all");
  const [onlyFailed, setOnlyFailed] = useState(false);

  // Вердикты пересчитываются по текущим правилам один раз и используются во всех блоках экрана
  const live = useMemo(
    () => new Map(journal.map((a) => [a.id, evaluateAttempt(a.events, a.evaluation.collisions, ruleSet)] as const)),
    [journal, ruleSet]
  );

  const studentNames = useMemo(() => {
    const names = new Set<string>();
    for (const a of journal) names.add(studentOf(a));
    names.delete(UNKNOWN_STUDENT);
    return [...names].sort((a, b) => a.localeCompare(b, "ru"));
  }, [journal]);

  const scenarioOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of journal) if (!seen.has(a.scenarioId)) seen.set(a.scenarioId, a.scenarioTitle);
    return [...seen.entries()];
  }, [journal]);

  const filtered = useMemo(() => {
    return journal.filter((a) => {
      if (studentFilter !== "all" && studentOf(a) !== studentFilter) return false;
      if (scenarioFilter !== "all" && a.scenarioId !== scenarioFilter) return false;
      if (onlyFailed && live.get(a.id)?.verdict !== "НЕ СДАЛ") return false;
      return true;
    });
  }, [journal, studentFilter, scenarioFilter, onlyFailed, live]);

  const summary = useMemo(() => summarizeAttempts(filtered, ruleSet), [filtered, ruleSet]);
  const agreement = useMemo(() => summarizeAgreement(filtered, ruleSet), [filtered, ruleSet]);
  const maxViolationCount = summary.violations[0]?.count ?? 1;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="mint">Кабинет инструктора</Chip>
            <Chip tone="amber">{ruleSet.version}</Chip>
            <Chip tone={ruleSet.status === "instructor_signed" ? "mint" : "red"}>
              {ruleSet.status === "instructor_signed" ? "правила подписаны" : "правила не проверены"}
            </Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Статистика учеников и отчёты</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1">
            Журнал попыток, доля сданных заездов, типичные нарушения, сверка с инструктором и экспорт для автошколы.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 panel-soft px-2.5 py-1.5">
            <span className="mono text-[10px] text-[#7c909d]">УЧЕНИК</span>
            <input
              type="text"
              value={activeStudent}
              onChange={(e) => onActiveStudentChange(e.target.value)}
              placeholder="Фамилия И.О."
              className="w-[130px] bg-transparent text-xs text-white outline-none placeholder:text-[#5b6f7d]"
              title="Новые попытки будут подписаны этим учеником"
            />
          </label>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              if (filtered.length === 0) {
                onNotify("Нечего экспортировать: в выборке нет попыток");
                return;
              }
              downloadCsv(`cdt-report-${today}.csv`, attemptsToCsv(filtered, ruleSet));
              onNotify(`CSV-отчёт сохранён, попыток: ${filtered.length}`);
            }}
          >
            <Icon name="download" size={13} /> CSV для Excel
          </button>
          <button
            type="button"
            className="btn btn-mini"
            title="Сводка и попытки без траекторий. Полные записи — в golden-наборе на вкладке «Разбор и Реплей»"
            onClick={() => {
              if (filtered.length === 0) {
                onNotify("Нечего экспортировать: в выборке нет попыток");
                return;
              }
              downloadJson(
                `cdt-analytics-${today}.json`,
                { generatedAt: new Date().toISOString(), ruleSet, summary, agreement, attempts: filtered },
                onNotify
              );
            }}
          >
            <Icon name="file" size={13} /> JSON
          </button>
          <button type="button" className="btn btn-primary btn-mini" onClick={onOpenSimulator}>
            <Icon name="car" size={13} /> Новый заезд
          </button>
        </div>
      </div>

      {storageReady && storageBackend === "memory" && (
        <div className="panel p-4 border-[#ff6b6b]/50 text-[12px] text-[#fecaca] flex items-start gap-2.5">
          <Icon name="alert" size={16} className="text-[#ff6b6b] shrink-0 mt-0.5" />
          <span>
            Хранилище IndexedDB недоступно{storageError ? ` (${storageError})` : ""}. Журнал работает только до
            закрытия вкладки — выгрузите CSV или golden-набор, чтобы не потерять попытки.
          </span>
        </div>
      )}

      {!storageReady ? (
        <div className="panel p-8 text-center text-[13px] text-[#9bafbc]">Журнал загружается…</div>
      ) : journal.length === 0 ? (
        <div className="panel p-8 text-center">
          <div className="inline-grid place-items-center h-12 w-12 rounded-2xl bg-[#f5b942]/15 text-[#f5b942] mb-4">
            <Icon name="clipboard" size={22} />
          </div>
          <h3 className="text-lg font-extrabold mb-2">Журнал пока пуст</h3>
          <p className="text-[13px] text-[#9bafbc] max-w-xl mx-auto mb-5">
            Выполните заезд в 3D-тренажёре и нажмите «Завершить → Разбор». Попытка попадёт в журнал, а здесь
            появятся показатели ученика и темы для разбора.
          </p>
          <button type="button" className="btn btn-primary" onClick={onOpenSimulator}>
            <Icon name="car" size={15} /> Перейти в тренажёр
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              label="ПОПЫТОК В ВЫБОРКЕ"
              value={String(summary.total)}
              hint={`В журнале ${journal.length} из ${journalLimit} · ${
                storageBackend === "indexeddb" ? "IndexedDB" : "только в памяти"
              }`}
            />
            <Kpi
              label="ДОЛЯ СДАННЫХ"
              value={`${summary.passRate}%`}
              tone={summary.passRate >= 60 ? "text-[#52d6bd]" : "text-[#ff6b6b]"}
              hint={`${summary.passed} сдал · ${summary.failed} не сдал (порог ${ruleSet.failThreshold} б.)`}
            />
            <Kpi
              label="СРЕДНИЙ ШТРАФ"
              value={`${summary.avgPoints} б.`}
              hint="Все баллы на этом экране пересчитаны по текущей версии правил"
            />
            <Kpi
              label="УЧЕНИКОВ"
              value={String(summary.students.length)}
              tone="text-[#d3e0e7]"
              hint={`Средняя длительность заезда: ${summary.avgDurationSec} с`}
            />
          </div>

          <div className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[10px] text-[#6e8492] mr-1">ФИЛЬТР</span>
              <select
                value={studentFilter}
                onChange={(e) => setStudentFilter(e.target.value)}
                className="rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-[11px] text-white"
              >
                <option value="all">Все ученики</option>
                {studentNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                {journal.some((a) => studentOf(a) === UNKNOWN_STUDENT) && (
                  <option value={UNKNOWN_STUDENT}>{UNKNOWN_STUDENT}</option>
                )}
              </select>
              <select
                value={scenarioFilter}
                onChange={(e) => setScenarioFilter(e.target.value)}
                className="rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-[11px] text-white"
              >
                <option value="all">Все сценарии</option>
                {scenarioOptions.map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-[#9bafbc] cursor-pointer">
                <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
                Только «НЕ СДАЛ»
              </label>
              <span className="mono text-[10px] text-[#7c909d] ml-auto">
                Показано {filtered.length} из {journal.length}
              </span>
              <button type="button" className="btn btn-mini" onClick={onClearJournal}>
                <Icon name="trash" size={12} /> Очистить журнал
              </button>
            </div>
          </div>

          {/* Сверка с инструктором: метрика этапа «Доверие к оценке» */}
          <div className="panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
              <div>
                <div className="text-xs font-extrabold">Сверка с инструктором</div>
                <div className="text-[11px] text-[#7c909d] mt-0.5">
                  Цель: вердикты симулятора и инструкторов совпадают не реже {agreement.target}% при выборке от{" "}
                  {MIN_REVIEWS_FOR_VERDICT} оценок.
                </div>
              </div>
              <Chip tone={STATUS_TONE[agreement.status]}>{statusLabel(agreement)}</Chip>
            </div>

            {agreement.reviews === 0 ? (
              <p className="text-[12px] text-[#9bafbc] leading-relaxed">
                Оценок инструктора в выборке пока нет. Откройте попытку во вкладке «Разбор и Реплей», посмотрите
                реплей и поставьте свой вердикт — лучше в режиме слепой сверки. Чтобы вывод был содержательным,
                нужно 10–20 заездов, оценённых двумя-тремя инструкторами.
              </p>
            ) : (
              <div className="grid lg:grid-cols-[.8fr_1.2fr] gap-5">
                <div>
                  <div className="flex items-end gap-3">
                    <div
                      className={`mono text-4xl font-extrabold ${
                        agreement.status === "meets_target"
                          ? "text-[#52d6bd]"
                          : agreement.status === "below_target"
                            ? "text-[#ff6b6b]"
                            : "text-[#d3e0e7]"
                      }`}
                    >
                      {agreement.agreementRate}%
                    </div>
                    <div className="text-[11px] text-[#9bafbc] pb-1.5">
                      совпало {agreement.agree} из {agreement.reviews} {isOne(agreement.reviews) ? "оценки" : "оценок"}
                      <br />
                      по {agreement.reviewedAttempts} {isOne(agreement.reviewedAttempts) ? "заезду" : "заездам"}
                    </div>
                  </div>
                  {agreement.intervalLow !== null && agreement.intervalHigh !== null && (
                    <div className="mono text-[10px] text-[#7c909d] mt-2">
                      95% интервал: {agreement.intervalLow}–{agreement.intervalHigh}% (ориентир: оценки одного заезда
                      не независимы)
                    </div>
                  )}
                  {agreement.status === "insufficient" && (
                    <div className="text-[11px] text-[#f5d78a] mt-2 leading-relaxed">
                      По такой выборке вывод делать рано: процент показан для ориентира, статус цели не выставляется.
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    {(
                      [
                        ["Симулятор мягче", agreement.simTooLenient, "пропустил то, что инструктор считает провалом"],
                        ["Симулятор строже", agreement.simTooStrict, "не засчитал то, что инструктор принял"],
                        ["Инструкторы разошлись", agreement.instructorsSplit, "заезды с разными вердиктами инструкторов"],
                      ] as const
                    ).map(([label, value, hint]) => (
                      <div key={label} className="panel-soft p-2.5" title={hint}>
                        <div className="mono text-lg font-bold text-[#e9f1f5]">{value}</div>
                        <div className="text-[10px] text-[#8fa2ae] leading-snug">{label}</div>
                      </div>
                    ))}
                  </div>
                  {agreement.instructors.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {agreement.instructors.map((i) => (
                        <div key={i.name} className="flex items-center gap-2 text-[11px]">
                          <span className="flex-1 truncate text-[#cbd5e1]">{i.name}</span>
                          <span className="mono text-[#8fa2ae]">
                            {i.agree}/{i.reviews}
                          </span>
                          <span className="mono text-[#e9f1f5] w-12 text-right">{i.rate}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="mono text-[10px] text-[#6e8492] mb-2">РАСХОЖДЕНИЯ ДЛЯ РАЗБОРА</div>
                  {agreement.disagreements.length === 0 ? (
                    <div className="text-[12px] text-[#52d6bd]">Расхождений нет: все оценки совпали с симулятором.</div>
                  ) : (
                    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 scroll-thin">
                      {agreement.disagreements.map((d) => {
                        const meta = journal.find((a) => a.id === d.attemptId);
                        return (
                          <div key={`${d.attemptId}:${d.instructor}`} className="panel-soft p-3">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <Chip tone={d.kind === "sim_too_lenient" ? "red" : "amber"}>
                                {d.kind === "sim_too_lenient" ? "симулятор мягче" : "симулятор строже"}
                              </Chip>
                              <span className="text-[11px] text-[#cbd5e1]">
                                {d.scenarioTitle} · {d.student}
                              </span>
                              {meta && (
                                <button
                                  type="button"
                                  className="mono text-[11px] text-[#f5b942] hover:underline ml-auto"
                                  onClick={() => onSelectAttempt(meta)}
                                >
                                  Разбор →
                                </button>
                              )}
                            </div>
                            <div className="text-[11px] text-[#e9f1f5]">
                              Симулятор: {d.simVerdict} ({d.simPoints} б.) · {d.instructor}: {d.instructorVerdict}
                            </div>
                            <div className="text-[10px] text-[#8fa2ae] mt-0.5">
                              {d.violations.length > 0
                                ? `Симулятор зафиксировал: ${d.violations.join("; ")}`
                                : "Симулятор не зафиксировал нарушений"}
                            </div>
                            {d.comment && <div className="text-[10px] text-[#f5d78a] mt-0.5">Комментарий: {d.comment}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-4">
            <div className="panel p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-extrabold">Успеваемость по ученикам</div>
                <span className="mono text-[10px] text-[#7c909d]">порог {ruleSet.failThreshold} б.</span>
              </div>
              {summary.students.length === 0 ? (
                <div className="text-[12px] text-[#7c909d]">В выборке нет попыток.</div>
              ) : (
                <div className="space-y-2">
                  {summary.students.map((st) => (
                    <div key={st.student} className="panel-soft p-3">
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <span className="text-[12px] font-bold flex-1 min-w-0 truncate">{st.student}</span>
                        <span className="mono text-[10px] text-[#8fa2ae]">{st.attempts} поп.</span>
                        <span
                          className={`mono text-[11px] font-bold ${
                            st.passRate >= 60 ? "text-[#52d6bd]" : st.passRate > 0 ? "text-[#f5b942]" : "text-[#ff6b6b]"
                          }`}
                        >
                          {st.passRate}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded bg-[rgba(148,176,194,.14)] overflow-hidden">
                        <div
                          className={`h-full transition-all ${st.passRate >= 60 ? "bg-[#52d6bd]" : "bg-[#f5b942]"}`}
                          style={{ width: `${st.passRate}%` }}
                        />
                      </div>
                      <div className="mono text-[10px] text-[#7c909d] mt-1.5 flex flex-wrap gap-x-3">
                        <span>средний штраф {st.avgPoints} б.</span>
                        <span>лучший {st.bestPoints} б.</span>
                        <span>≈{st.avgDurationSec} с</span>
                        {st.lastAttemptAt && <span>{new Date(st.lastAttemptAt).toLocaleDateString("ru-RU")}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel p-5">
              <div className="text-xs font-extrabold mb-3">Типичные нарушения</div>
              {summary.violations.length === 0 ? (
                <div className="text-[12px] text-[#52d6bd]">Нарушений в выборке нет.</div>
              ) : (
                <div className="space-y-2.5">
                  {summary.violations.slice(0, 7).map((v) => (
                    <div key={v.code}>
                      <div className="flex items-start gap-2 mb-1">
                        <span className="text-[11px] leading-snug flex-1 text-[#d3e0e7]">{v.title}</span>
                        <span className="mono text-[10px] text-[#ff9494] shrink-0">
                          ×{v.count} · {v.points} б.
                        </span>
                      </div>
                      <div className="h-1 rounded bg-[rgba(148,176,194,.14)] overflow-hidden">
                        <div className="h-full bg-[#ff6b6b]" style={{ width: `${(v.count / maxViolationCount) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-xs font-extrabold">Попытки</div>
              <div className="flex flex-wrap gap-2">
                {summary.scenarios.map((s) => (
                  <Chip key={s.scenarioId} tone="neutral">
                    {s.title}: {s.attempts} · {s.passRate}%
                  </Chip>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto scroll-thin max-h-[460px] overflow-y-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="mono text-[10px] text-[#6e8492] border-b hairline">
                  <tr>
                    <th className="py-2 pr-3">Дата</th>
                    <th className="py-2 pr-3">Ученик</th>
                    <th className="py-2 pr-3">Сценарий</th>
                    <th className="py-2 pr-3">Симулятор</th>
                    <th className="py-2 pr-3">Штраф</th>
                    <th className="py-2 pr-3">Инструкторы</th>
                    <th className="py-2 pr-3">Время</th>
                    <th className="py-2">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const ev = live.get(a.id);
                    const verdict = ev?.verdict ?? a.evaluation.verdict;
                    return (
                      <tr key={a.id} className="border-b hairline last:border-0">
                        <td className="py-2 pr-3 mono text-[11px] text-[#8fa2ae] whitespace-nowrap">
                          {new Date(a.createdAt).toLocaleString("ru-RU", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="text"
                            value={a.student ?? ""}
                            placeholder={UNKNOWN_STUDENT}
                            onChange={(e) => onUpdateStudent(a.id, e.target.value)}
                            className="w-[130px] bg-transparent border-b border-transparent hover:border-[rgba(148,176,194,.3)] focus:border-[#f5b942] text-[12px] text-white outline-none"
                          />
                        </td>
                        <td className="py-2 pr-3 text-[11px] text-[#cbd5e1]">{a.scenarioTitle}</td>
                        <td className="py-2 pr-3">
                          <Chip tone={verdict === "СДАЛ" ? "mint" : "red"}>{verdict}</Chip>
                          {!a.closed && <span className="ml-1.5"><Chip tone="amber">в процессе</Chip></span>}
                        </td>
                        <td className="py-2 pr-3 mono">{ev?.totalPoints ?? a.evaluation.totalPoints} б.</td>
                        <td className="py-2 pr-3 text-[11px]">
                          {(a.reviews ?? []).length === 0 ? (
                            <span className="text-[#5b6f7d]">—</span>
                          ) : (
                            (a.reviews ?? []).map((r) => (
                              <span
                                key={r.instructor}
                                className={`mr-2 whitespace-nowrap ${
                                  r.verdict === verdict ? "text-[#52d6bd]" : "text-[#ff9494]"
                                }`}
                                title={r.verdict === verdict ? "Совпало с симулятором" : "Расхождение с симулятором"}
                              >
                                {r.instructor}: {r.verdict}
                              </span>
                            ))
                          )}
                        </td>
                        <td className="py-2 pr-3 mono text-[#8fa2ae]">{a.durationSec} с</td>
                        <td className="py-2">
                          <button
                            type="button"
                            className="mono text-[11px] text-[#f5b942] hover:underline"
                            onClick={() => onSelectAttempt(a)}
                          >
                            Разбор →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
