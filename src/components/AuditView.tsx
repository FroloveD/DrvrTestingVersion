import { useEffect, useMemo, useState } from "react";
import {
  checklist,
  drifts,
  improvements,
  phases,
  planMarkdown,
  risks,
  sources,
  type Improvement,
  type Tier,
} from "../data";
import { Chip, CopyButton, Icon } from "./Icons";

const IMPLEMENTED_IDS = new Set([
  "offline",
  "rules",
  "core",
  "tests",
  "modules",
  "replay",
  "osm",
  "perf",
  "scenarios",
  "instructor",
  "input",
]);

const tierTone: Record<Tier, "red" | "amber" | "mint"> = { P0: "red", P1: "amber", P2: "mint" };

export function AuditView({
  onNotify,
  onOpenSim,
}: {
  onNotify: (msg: string) => void;
  onOpenSim: () => void;
}) {
  const [subTab, setSubTab] = useState<"priorities" | "drifts" | "roadmap" | "risks" | "checklist">("priorities");
  const [tier, setTier] = useState<"all" | Tier>("all");
  const [sort, setSort] = useState<"roi" | "impact" | "effort">("roi");
  const [selected, setSelected] = useState("rules");
  const [phase, setPhase] = useState(0);
  const [done, setDone] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("cdt-checklist-v1") || '["c1","c3","c4","c6"]');
    } catch {
      return ["c1", "c3", "c4", "c6"];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("cdt-checklist-v1", JSON.stringify(done));
    } catch {
      // storage blocked
    }
  }, [done]);

  const filtered = useMemo(() => {
    const list = improvements.filter((i) => tier === "all" || i.tier === tier);
    return [...list].sort((a, b) => {
      if (sort === "impact") return b.impact - a.impact || a.effort - b.effort;
      if (sort === "effort") return a.effort - b.effort || b.impact - a.impact;
      return b.impact / b.effort - a.impact / a.effort;
    });
  }, [tier, sort]);

  const chosen = (improvements.find((i) => i.id === selected) ?? improvements[0]) as Improvement;
  const progress = Math.min(100, (done.length / checklist.length) * 100);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Архитектурный аудит CytyDrivingTraining</Chip>
            <Chip tone="mint">{IMPLEMENTED_IDS.size} из 14 пунктов уже собраны в прототипе</Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Диагноз репозитория, приоритеты и дорожная карта</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={planMarkdown} label="План на 7 дней" onDone={onNotify} />
          <button type="button" className="btn btn-primary btn-mini" onClick={onOpenSim}>
            <Icon name="car" size={13} /> Открыть тренажёр
          </button>
        </div>
      </div>

      {/* Подвкладки разделов аудита */}
      <div className="segmented flex-wrap">
        {([
          ["priorities", "Матрица 14 улучшений"],
          ["drifts", "8 расхождений"],
          ["roadmap", "4 этапа плана"],
          ["risks", "Реестр рисков"],
          ["checklist", `Чек-лист (${done.length}/${checklist.length})`],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={subTab === id ? "on" : ""} onClick={() => setSubTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {subTab === "priorities" && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="segmented">
              {(["all", "P0", "P1", "P2"] as const).map((t) => (
                <button key={t} type="button" className={tier === t ? "on" : ""} onClick={() => setTier(t)}>
                  {t === "all" ? "Все" : t}
                </button>
              ))}
            </div>
            <div className="segmented">
              {([
                ["roi", "По ROI"],
                ["impact", "По эффекту"],
                ["effort", "По простоте"],
              ] as const).map(([v, l]) => (
                <button key={v} type="button" className={sort === v ? "on" : ""} onClick={() => setSort(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="grid lg:grid-cols-[1fr_350px] gap-4 items-start">
            <div className="grid sm:grid-cols-2 gap-3">
              {filtered.map((im) => {
                const doneHere = IMPLEMENTED_IDS.has(im.id);
                return (
                  <button
                    key={im.id}
                    type="button"
                    onClick={() => setSelected(im.id)}
                    className={`panel p-4 text-left transition hover:-translate-y-0.5 ${
                      selected === im.id ? "border-[#f5b942]/60" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Chip tone={tierTone[im.tier]}>{im.tier}</Chip>
                      {doneHere && <Chip tone="mint">✓ в коде</Chip>}
                      <span className="mono text-[10px] text-[#f5b942] ml-auto">
                        ROI {(im.impact / im.effort).toFixed(1)}
                      </span>
                    </div>
                    <div className="text-[13px] font-bold leading-snug mb-2">{im.title}</div>
                    <div className="mono text-[10px] text-[#7c909d]">
                      Эффект {im.impact}/10 · Труд {im.effort}/10 · {im.duration}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="panel p-5 lg:sticky lg:top-6">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <Chip tone={tierTone[chosen.tier]}>{chosen.tier}</Chip>
                <Chip>{chosen.category}</Chip>
                {IMPLEMENTED_IDS.has(chosen.id) && <Chip tone="mint">реализовано здесь</Chip>}
              </div>
              <h3 className="text-lg font-extrabold leading-tight mb-2">{chosen.title}</h3>
              <p className="text-[12px] leading-relaxed text-[#b9c9d3] mb-4">{chosen.problem}</p>
              <div className="mono text-[10px] text-[#6e8492] mb-2">ШАГИ</div>
              <ol className="space-y-2 mb-4">
                {chosen.actions.map((a, i) => (
                  <li key={i} className="flex gap-2 text-[12px] text-[#d3e0e7]">
                    <span className="mono text-[#f5b942]">{i + 1}.</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ol>
              <div className="panel-soft p-3 text-[11px]">
                <div className="mono text-[10px] text-[#6e8492] mb-1">КРИТЕРИЙ ГОТОВНОСТИ</div>
                <div className="text-[#52d6bd]">{chosen.done}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === "drifts" && (
        <div className="grid gap-3">
          {drifts.map((d, i) => (
            <div key={i} className="panel p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="mono text-[11px] text-[#6e8492]">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-sm font-extrabold flex-1">{d.topic}</span>
                <Chip tone={i === 4 || i === 6 ? "red" : "amber"}>
                  {i === 4 || i === 6 ? "исправлено в ядре" : "учтено"}
                </Chip>
              </div>
              <div className="grid md:grid-cols-3 gap-2.5 text-[12px]">
                <div className="panel-soft p-3">
                  <div className="mono text-[10px] text-[#6e8492] mb-1">README</div>
                  <div className="text-[#9bafbc]">{d.readme}</div>
                </div>
                <div className="panel-soft p-3">
                  <div className="mono text-[10px] text-[#6e8492] mb-1">DEV_PROMPTS</div>
                  <div className="text-[#9bafbc]">{d.doc}</div>
                </div>
                <div className="panel-soft p-3">
                  <div className="mono text-[10px] text-[#6e8492] mb-1">КОД V8</div>
                  <div className="text-[#52d6bd]">{d.code}</div>
                </div>
              </div>
              <div className="text-[12px] text-[#d8e4ea] mt-2.5 flex items-start gap-2">
                <Icon name="arrow" size={14} className="text-[#f5b942] shrink-0 mt-0.5" />
                <span>{d.verdict}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {subTab === "roadmap" && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {phases.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPhase(i)}
                className={`panel p-4 text-left transition ${phase === i ? "border-[#f5b942]/60" : ""}`}
              >
                <div className="flex justify-between items-center mb-2">
                  <span className="mono text-2xl font-bold text-[#f5b942]">{p.num}</span>
                  <Chip tone={i < 3 ? "mint" : "amber"}>{p.period}</Chip>
                </div>
                <div className="text-[13px] font-extrabold mb-1">{p.title}</div>
                <div className="text-[11px] text-[#8fa2ae]">{p.goal}</div>
              </button>
            ))}
          </div>
          <div className="grid lg:grid-cols-[1.2fr_.8fr] gap-4">
            <div className="panel p-5">
              <div className="text-sm font-extrabold mb-3">
                Этап {phases[phase].num}: {phases[phase].title}
              </div>
              <div className="space-y-2">
                {phases[phase].tasks.map((t, idx) => (
                  <div key={idx} className="panel-soft p-3 text-[12px] flex gap-2.5">
                    <span className="mono text-[#f5b942]">{idx + 1}.</span>
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel p-5 space-y-3">
              <div className="text-xs font-extrabold text-[#52d6bd]">Definition of Done</div>
              {phases[phase].dod.map((d, idx) => (
                <div key={idx} className="flex gap-2 text-[12px] text-[#b9c9d3]">
                  <Icon name="check" size={14} className="text-[#52d6bd] shrink-0 mt-0.5" />
                  <span>{d}</span>
                </div>
              ))}
              <div className="pt-3 border-t hairline text-[12px]">
                <span className="mono text-[10px] text-[#6e8492] block mb-1">МЕТРИКА ЭТАПА</span>
                <b className="text-[#f5b942]">{phases[phase].metric}</b>
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === "risks" && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            {risks.map((r, i) => (
              <div key={i} className="panel p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Chip tone={r.level === "Высокий" ? "red" : "amber"}>{r.level}</Chip>
                  <span className="mono text-[10px] text-[#6e8492] ml-auto">{r.area}</span>
                </div>
                <div className="text-[13px] font-bold mb-1.5">{r.title}</div>
                <div className="text-[11px] text-[#9bafbc] mb-2.5">{r.effect}</div>
                <div className="text-[11px] text-[#d3e0e7] border-t hairline pt-2 flex gap-2">
                  <Icon name="shield" size={13} className="text-[#52d6bd] shrink-0 mt-0.5" />
                  <span>{r.mitigation}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="panel p-4">
            <div className="text-xs font-extrabold mb-3">Источники и ссылки</div>
            <div className="grid sm:grid-cols-2 gap-2">
              {sources.map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="panel-soft p-2.5 text-[12px] flex items-center gap-2 hover:border-[#f5b942]/50"
                >
                  <Icon name="external" size={13} className="text-[#f5b942] shrink-0" />
                  <span className="truncate">{s.label}</span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === "checklist" && (
        <div className="grid lg:grid-cols-[1.2fr_.8fr] gap-4">
          <div className="panel p-5 space-y-2">
            {checklist.map((c, i) => {
              const checked = done.includes(c.id);
              return (
                <label
                  key={c.id}
                  className={`panel-soft p-3 flex items-start gap-3 cursor-pointer ${
                    checked ? "border-[#52d6bd]/45 bg-[#52d6bd]/5" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setDone((d) => (d.includes(c.id) ? d.filter((x) => x !== c.id) : [...d, c.id]))
                    }
                    className="mt-1"
                  />
                  <span className="flex-1 text-[12px]">
                    <span className={checked ? "line-through text-[#7c909d]" : "text-[#e9f1f5]"}>{c.text}</span>
                    <span className="block mono text-[10px] text-[#6e8492] mt-0.5">
                      {String(i + 1).padStart(2, "0")} · {c.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="panel p-6 text-center flex flex-col items-center justify-center">
            <div className="mono text-[10px] text-[#6e8492] mb-3">ПРОГРЕСС ПЕРЕНОСА В РЕПОЗИТОРИЙ</div>
            <div className="mono text-4xl font-extrabold text-[#f5b942]">{Math.round(progress)}%</div>
            <div className="text-xs text-[#9bafbc] mt-2">
              {done.length} из {checklist.length} шагов отмечено
            </div>
            <div className="w-full h-2 rounded bg-white/10 mt-4 overflow-hidden">
              <div className="h-full bg-[#52d6bd] transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
