/**
 * @module components/StrategyView
 * @layer ui
 * @role Вкладка «План и стратегия»: принципы, дорожная карта, приоритеты, журнал решений, чек-лист действий и экспорт `strategy.md`.
 * @tests T20 (`src/sim/selfTest.ts`), смоук A (`tests/browser-smoke.mjs`)
 */
import { useMemo, useState } from "react";
import {
  DECISIONS,
  NEXT_ACTIONS,
  PRIORITIES,
  PRINCIPLES,
  STRATEGY_PHASES,
  loadStrategyProgress,
  saveStrategyProgress,
  strategyToMarkdown,
  type PhaseStatus,
} from "../strategy/plan";
import { Chip, CopyButton, downloadText, Icon } from "./Icons";

const STATUS_META: Record<PhaseStatus, { label: string; tone: "mint" | "amber" | "neutral"; icon: string }> = {
  done: { label: "завершена", tone: "mint", icon: "check" },
  active: { label: "идёт", tone: "amber", icon: "play" },
  next: { label: "следующая", tone: "amber", icon: "arrow" },
  later: { label: "потом", tone: "neutral", icon: "calendar" },
};

export function StrategyView({ onNotify }: { onNotify: (msg: string) => void }) {
  const [phaseId, setPhaseId] = useState("ph5");
  const [done, setDone] = useState<string[]>(loadStrategyProgress);
  const [showMarkdown, setShowMarkdown] = useState(false);

  const phase = STRATEGY_PHASES.find((p) => p.id === phaseId) ?? STRATEGY_PHASES[0];
  const markdown = useMemo(() => strategyToMarkdown(), []);
  const progress = Math.min(100, (done.length / NEXT_ACTIONS.length) * 100);

  const toggleAction = (id: string) => {
    setDone((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveStrategyProgress(next);
      return next;
    });
  };

  const donePhases = STRATEGY_PHASES.filter((p) => p.status === "done").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Ревизия стратегии</Chip>
            <Chip tone="mint">{donePhases} из {STRATEGY_PHASES.length} фаз завершено</Chip>
            <Chip tone="neutral">прогресс действий: {done.length}/{NEXT_ACTIONS.length}</Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Стратегия CityDrivingTraining</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1 max-w-3xl">
            Актуальный план ветки exam-routes: сначала надёжность крупных OSM-сцен и каталог маршрутов, затем калибровка и пилот.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={markdown} label="Скопировать стратегию" onDone={onNotify} />
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => downloadText("strategy.md", markdown, onNotify)}
          >
            <Icon name="download" size={13} /> strategy.md
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => setShowMarkdown((v) => !v)}
          >
            <Icon name="file" size={13} /> {showMarkdown ? "Скрыть текст" : "Показать текст"}
          </button>
        </div>
      </div>

      {showMarkdown && (
        <div className="panel p-4 fade-in">
          <pre className="mono text-[11px] leading-[1.7] text-[#b9c9d3] panel-soft p-3 overflow-x-auto scroll-thin whitespace-pre-wrap max-h-[420px]">
            {markdown}
          </pre>
        </div>
      )}

      {/* Текущее состояние */}
      <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-4">
        <div className="panel p-5">
          <div className="flex items-center gap-2 text-[#52d6bd] text-sm font-extrabold mb-3">
            <Icon name="check" size={16} /> Что уже доказано кодом
          </div>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2.5">
            {[
              "Детерминированное ядро: 33/33 автотестов, реплей совпадает побитно",
              "Офлайн-бандл без внешних запросов, холодный старт P и блокировки АКПП",
              "Правила как данные, golden-набор с checksum, сверка с инструкторами (ДИ Уилсона)",
              "OSM: XML / Overpass JSON / GeoJSON, one-way, roundabout, multipolygon и обрезка по полигону",
              "Редактор: произвольные границы, дороги по точкам, скругления, метрическая сетка и 2D/3D-сборка",
              "Журнал в IndexedDB (до 300 заездов), статистика учеников, USB-руль и выворот 33–42°",
              "Правовые блоки: атрибуция ODbL, дисклеймер, бэкап, удаление данных",
              "CI: Playwright A–P проходит по HTTP и file://; Core / Types / Docs / Offline gate зелёный",
            ].map((t, i) => (
              <div key={i} className="flex gap-2.5 text-[12px] leading-relaxed text-[#b9c9d3]">
                <span className="text-[#52d6bd] mt-0.5">✓</span>
                <span>{t}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel p-5 border-[rgba(245,185,66,.3)]">
          <div className="flex items-center gap-2 text-[#f5b942] text-sm font-extrabold mb-3">
            <Icon name="alert" size={16} /> Главный риск стратегии
          </div>
          <p className="text-[13px] leading-relaxed text-[#b9c9d3]">
            Главная текущая инженерная задача — проверить корректность построения крупных OSM-сцен и завершить каталог экзаменационных маршрутов. Отдельный продуктовый риск остаётся: правила оценки имеют статус <span className="mono text-[#f5b942]">unvalidated</span> до сверки и подписи инструкторов. Поэтому пилот и заявления о соответствии экзамену отложены до калибровки.
          </p>
          <div className="mt-4 pt-3 border-t hairline flex items-center justify-between text-[11px] text-[#8fa2ae]">
            <span>Следующая фаза</span>
            <span className="mono text-[#f5b942]">4 · Надёжность OSM и производительность</span>
          </div>
        </div>
      </div>

      {/* Принципы */}
      <div className="panel p-5">
        <div className="text-xs font-extrabold mb-4">Стратегические принципы</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PRINCIPLES.map((p, i) => (
            <div key={p.title} className="panel-soft p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="mono text-[11px] text-[#f5b942] font-bold">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[13px] font-extrabold text-[#e9f1f5]">{p.title}</span>
              </div>
              <div className="text-[12px] leading-relaxed text-[#d3e0e7]">{p.text}</div>
              <div className="text-[11px] leading-relaxed text-[#8fa2ae] mt-2 pt-2 border-t hairline">
                <span className="mono text-[9px] text-[#6e8492] block mb-0.5">ПОЧЕМУ</span>
                {p.why}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Фазы */}
      <div className="panel p-5">
        <div className="text-xs font-extrabold mb-4">Дорожная карта (ревизия)</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
          {STRATEGY_PHASES.map((p) => {
            const meta = STATUS_META[p.status];
            const active = phaseId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPhaseId(p.id)}
                className={`panel-soft p-4 text-left transition hover:-translate-y-0.5 ${
                  active ? "border-[#f5b942]/60 bg-[#f5b942]/5" : ""
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`mono text-2xl font-bold ${active ? "text-[#f5b942]" : "text-[#4f6472]"}`}>
                    {p.num}
                  </span>
                  <Chip tone={meta.tone}>
                    <Icon name={meta.icon} size={11} /> {meta.label}
                  </Chip>
                </div>
                <div className="text-[13px] font-extrabold mb-1">{p.title}</div>
                <div className="text-[11px] text-[#8fa2ae] leading-snug">{p.goal}</div>
                <div className="mono text-[10px] text-[#6e8492] mt-2.5">{p.period}</div>
              </button>
            );
          })}
        </div>

        <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-4">
          <div className="panel-soft p-4">
            <div className="text-[12px] font-extrabold mb-3">
              Этап {phase.num}: {phase.title}
            </div>
            {phase.done.length > 0 && (
              <>
                <div className="mono text-[10px] text-[#52d6bd] mb-2">СДЕЛАНО</div>
                <div className="space-y-1.5 mb-4">
                  {phase.done.map((d, i) => (
                    <div key={i} className="flex gap-2 text-[12px] text-[#b9c9d3]">
                      <Icon name="check" size={13} className="text-[#52d6bd] shrink-0 mt-0.5" />
                      <span>{d}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {phase.remaining.length > 0 && (
              <>
                <div className="mono text-[10px] text-[#f5b942] mb-2">ОСТАЛОСЬ</div>
                <div className="space-y-1.5">
                  {phase.remaining.map((r, i) => (
                    <div key={i} className="flex gap-2 text-[12px] text-[#d3e0e7]">
                      <span className="mono text-[#f5b942] shrink-0">{i + 1}.</span>
                      <span>{r}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="panel-soft p-4 flex flex-col">
            <div className="mono text-[10px] text-[#6e8492] mb-2">МЕТРИКА ЭТАПА</div>
            <div className="text-[13px] font-bold text-[#52d6bd] leading-relaxed">{phase.metric}</div>
            <div className="mt-auto pt-4">
              <div className="mono text-[10px] text-[#6e8492] mb-1.5">ОБЩИЙ ПРОГРЕСС ФАЗ</div>
              <div className="h-2 rounded bg-[rgba(148,176,194,.12)] overflow-hidden">
                <div
                  className="h-full bg-[#f5b942] transition-all"
                  style={{ width: `${(donePhases / STRATEGY_PHASES.length) * 100}%` }}
                />
              </div>
              <div className="mono text-[10px] text-[#8fa2ae] mt-1.5">
                {donePhases} из {STRATEGY_PHASES.length} завершено
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Приоритеты */}
      <div className="panel p-5">
        <div className="text-xs font-extrabold mb-4">Приоритеты: что делаем, что — нет</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {PRIORITIES.map((b) => (
            <div key={b.id} className="panel-soft p-4">
              <Chip tone={b.tone}>{b.title}</Chip>
              <div className="space-y-2 mt-3">
                {b.items.map((item, i) => (
                  <div key={i} className="flex gap-2 text-[12px] leading-relaxed text-[#d3e0e7]">
                    <span className="mono text-[#6e8492] shrink-0">{i + 1}.</span>
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Журнал решений */}
      <div className="panel p-5">
        <div className="text-xs font-extrabold mb-4">Журнал решений</div>
        <div className="space-y-2.5">
          {DECISIONS.map((d) => (
            <div key={d.title} className="panel-soft p-3 grid md:grid-cols-[110px_1fr_1.2fr] gap-2 md:gap-4">
              <div className="mono text-[11px] text-[#f5b942]">{d.date}</div>
              <div className="text-[12px] font-bold text-[#e9f1f5]">{d.title}</div>
              <div className="text-[12px] leading-relaxed text-[#b9c9d3]">
                {d.decision} <span className="text-[#7c909d]">— {d.reason}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Следующие действия */}
      <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-4 items-start">
        <div className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="text-xs font-extrabold">Следующие действия</div>
            <span className="mono text-[11px] text-[#7c909d]">
              {done.length}/{NEXT_ACTIONS.length} · прогресс сохраняется в браузере
            </span>
          </div>
          <div className="space-y-2">
            {NEXT_ACTIONS.map((a, i) => {
              const checked = done.includes(a.id);
              return (
                <label
                  key={a.id}
                  className={`panel-soft p-3 flex items-start gap-3 cursor-pointer transition ${
                    checked ? "border-[#52d6bd]/45 bg-[#52d6bd]/5" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleAction(a.id)}
                    className="mt-1"
                  />
                  <span className="flex-1 min-w-0">
                    <span className={`block text-[12px] leading-relaxed ${checked ? "line-through text-[#7c909d]" : "text-[#e9f1f5]"}`}>
                      {a.text}
                    </span>
                    <span className="block mono text-[10px] text-[#6e8492] mt-0.5">
                      {String(i + 1).padStart(2, "0")} · {a.hint}
                    </span>
                  </span>
                  {checked && <Icon name="check" size={14} className="text-[#52d6bd] shrink-0" />}
                </label>
              );
            })}
          </div>
          <div className="h-2 rounded bg-[rgba(148,176,194,.12)] mt-4 overflow-hidden">
            <div className="h-full bg-[#52d6bd] transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="panel p-5">
          <div className="flex items-center gap-2 text-xs font-extrabold mb-3">
            <Icon name="spark" size={14} className="text-[#f5b942]" />
            Главный сдвиг стратегии
          </div>
          <p className="text-[12px] leading-relaxed text-[#b9c9d3] mb-3">
            Этапы 0–3 закрыты: симулятор работает, данные накапливаются, инструмент для инструктора готов.
            Дальше ценность создаёт не новый код, а <strong className="text-white">доказательство доверия</strong>:
            калибровка с инструкторами, подпись правил и пилот в реальных школах.
          </p>
          <div className="space-y-2 text-[12px] text-[#d3e0e7]">
            <div className="flex gap-2">
              <span className="mono text-[#f5b942]">1.</span>
              <span>Не строить новые упражнения, пока оценка не подтверждена.</span>
            </div>
            <div className="flex gap-2">
              <span className="mono text-[#f5b942]">2.</span>
              <span>Каждый заезд в пилоте — это данные для калибровки и отчёта.</span>
            </div>
            <div className="flex gap-2">
              <span className="mono text-[#f5b942]">3.</span>
              <span>Распространение (Tauri, GitHub) — только после пилота.</span>
            </div>
          </div>
          <div className="panel-soft p-3 mt-4 text-[11px] leading-relaxed text-[#8fa2ae]">
            Полный текст стратегии — кнопка «strategy.md» выше: его можно положить в репозиторий рядом с
            README и обсуждать с командой как живой документ.
          </div>
        </div>
      </div>
    </div>
  );
}
