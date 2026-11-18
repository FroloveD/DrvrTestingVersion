/**
 * @module components/PrivacyLegalView
 * @layer ui
 * @role Правовой блок: атрибуция ODbL 1.0, учебный дисклеймер, заметка о лицензии, резервная копия `cdt.backup.v1` и очистка данных.
 * @invariants #8 (все данные локально), #9 (атрибуция ODbL 1.0), #16 (честный статус симуляции).
 * @tests Смоук J (`tests/browser-smoke.mjs`)
 */
import { useRef, useState } from "react";
import type { RuleSet } from "../scoring/rules";
import type { CustomScenarioDef } from "../scenarios/custom";
import { loadGamepadProfile } from "../input/browserGamepads";
import type { AttemptMeta } from "../sim/journal";
import type { CalibrationConfig } from "../sim/types";
import type { RecordedAttempt } from "../sim/recorder";
import { clearJournalStore, type JournalBackend } from "../storage/journalStore";
import { Chip, downloadJson, Icon } from "./Icons";

const LICENSE_KEY = "cdt.licenseNote.v1";

type Props = {
  journal: AttemptMeta[];
  storageBackend: JournalBackend;
  ruleSet: RuleSet;
  calibration: CalibrationConfig;
  customDef: CustomScenarioDef;
  loadAllAttempts: () => Promise<RecordedAttempt[]>;
  onClearJournal: () => void;
  onNotify: (msg: string) => void;
};

function readNote(): string {
  try {
    return localStorage.getItem(LICENSE_KEY) ?? "";
  } catch {
    return "";
  }
}

function StatusChip({ ok, label }: { ok: "done" | "todo" | "manual"; label?: string }) {
  if (ok === "done") return <Chip tone="mint">{label ?? "выполнено"}</Chip>;
  if (ok === "todo") return <Chip tone="red">{label ?? "решить владельцу"}</Chip>;
  return <Chip tone="amber">{label ?? "решение зафиксировано"}</Chip>;
}

/**
 * Политика данных, атрибуция и лицензии. Фактическая часть (где лежат данные, атрибуция ODbL,
 * дисклеймер) — зафиксирована здесь; юридический выбор лицензии делает владелец продукта,
 * поэтому пункт отмечен как незакрытый, пока решение не внесено.
 */
export function PrivacyLegalView({
  journal,
  storageBackend,
  ruleSet,
  calibration,
  customDef,
  loadAllAttempts,
  onClearJournal,
  onNotify,
}: Props) {
  const [note, setNote] = useState(readNote);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef(note);

  const saveNote = (value: string) => {
    setNote(value);
    noteRef.current = value;
    try {
      localStorage.setItem(LICENSE_KEY, value);
    } catch {
      // хранилище недоступно
    }
  };

  const exportAll = async () => {
    setBusy(true);
    try {
      const attempts = await loadAllAttempts();
      downloadJson(
        `cdt-backup-${new Date().toISOString().slice(0, 10)}.json`,
        {
          schema: "cdt.backup.v1",
          exportedAt: new Date().toISOString(),
          warning:
            "Файл содержит персональные данные учеников (ФИО) и полные записи заездов. Храните и передавайте по правилам вашей школы.",
          ruleset: ruleSet,
          calibration,
          customScenario: customDef,
          gamepadProfile: loadGamepadProfile(),
          licenseNote: noteRef.current,
          attempts,
        },
        onNotify
      );
    } catch (err) {
      onNotify(`Не удалось выгрузить данные: ${err instanceof Error ? err.message : "ошибка"}`);
    } finally {
      setBusy(false);
    }
  };

  const wipeAll = async () => {
    const ok = window.confirm(
      "Удалить ВСЕ данные из этого браузера: попытки и оценки инструкторов, правила, калибровку, свой сценарий, настройки и раскладку окон? Отменить это будет нельзя."
    );
    if (!ok) return;
    try {
      await clearJournalStore();
      localStorage.clear();
      onNotify("Все данные удалены — страница перезагружается…");
      window.setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      onNotify(`Не удалось удалить данные: ${err instanceof Error ? err.message : "ошибка хранилища"}`);
    }
  };

  const signed = ruleSet.status === "instructor_signed";
  const rows: Array<{ ok: "done" | "todo" | "manual"; title: string; detail: string }> = [
    {
      ok: "done",
      title: "Атрибуция картографических данных OSM",
      detail:
        "© OpenStreetMap contributors (ODbL 1.0) показывается на экране рядом с картой и в подвале. Отображённая карта — produced work: атрибуции достаточно.",
    },
    {
      ok: "done",
      title: "Дисклеймер об учебном характере",
      detail:
        "Симулятор везде назван учебной симуляцией: он не является официальным экзаменом ГИБДД и не заменяет обучение с инструктором.",
    },
    {
      ok: "done",
      title: "Политика хранения данных",
      detail: "Попытки, оценки и настройки хранятся только в этом браузере (IndexedDB и localStorage), на серверы проекта ничего не отправляется.",
    },
    {
      ok: signed ? "done" : "todo",
      title: "Критерии оценки подтверждены инструктором",
      detail: signed
        ? `Набор правил ${ruleSet.version} подписан (${ruleSet.instructorSignOff}).`
        : `Набор правил ${ruleSet.version} имеет статус «не проверено» — нужны подпись инструктора и ссылка на нормативный документ.`,
    },
    {
      ok: "todo",
      title: "LICENSE для исходного кода продукта",
      detail:
        "Выбирает владелец: распространение школам, подписка или бесплатное использование меняют условия. Ядро, карточки сценариев и рендер можно лицензировать отдельно от данных.",
    },
    {
      ok: "todo",
      title: "Обработка персональных данных учеников",
      detail:
        "Экспорт CSV, JSON и golden-наборы содержат ФИО. Решение о том, кто имеет к ним доступ и как долго они хранятся, принимает школа — тренажёр данные не передаёт.",
    },
    {
      ok: note.trim() ? "manual" : "todo",
      title: "Решение по распространению зафиксировано",
      detail: note.trim()
        ? "Заметка о лицензии сохранена в этом браузере и попадает в резервную выгрузку."
        : "Внесите решение в поле ниже — и пункт закроется.",
    },
  ];

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div className="text-xs font-extrabold">Данные, атрибуция и лицензии</div>
        <Chip tone={signed ? "mint" : "amber"}>
          {rows.filter((r) => r.ok === "done").length} из {rows.length} закрыто
        </Chip>
      </div>
      <p className="text-[11px] text-[#7c909d] leading-relaxed mb-4">
        Фактическая часть зафиксирована и видна в интерфейсе. Пункты, отмеченные «решить владельцу», — это
        юридический выбор, который делается вне тренажёра.
      </p>

      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.title} className="panel-soft p-3 flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-[220px]">
              <div className="text-[12px] font-bold text-[#e9f1f5]">{r.title}</div>
              <div className="text-[11px] text-[#9bafbc] leading-relaxed mt-1">{r.detail}</div>
            </div>
            <StatusChip ok={r.ok} />
          </div>
        ))}
      </div>

      <label className="block mt-4">
        <span className="mono text-[10px] text-[#7c909d] block mb-1">
          ЗАМЕТКА О ЛИЦЕНЗИИ И РАСПРОСТРАНЕНИИ (ЗАПОЛНЯЕТ ВЛАДЕЛЕЦ ПРОДУКТА)
        </span>
        <textarea
          value={note}
          onChange={(e) => saveNote(e.target.value)}
          rows={2}
          placeholder="Например: MIT для кода, по подписке для автошкол, пилот бесплатно до 2027-01-01"
          className="w-full rounded-lg bg-[#091017] border hairline px-2.5 py-2 text-xs text-white resize-y"
        />
      </label>

      <div className="grid lg:grid-cols-2 gap-3 mt-4">
        <div className="panel-soft p-3">
          <div className="text-[11px] font-bold text-[#e9f1f5] mb-1">Резервная копия</div>
          <div className="text-[11px] text-[#9bafbc] leading-relaxed mb-2.5">
            Выгрузка всех попыток с полной записью ввода, вердиктами инструкторов, правилами, калибровкой,
            своим сценарием и настройками руля. Храните файл на защищённом носителе школы.
          </div>
          <button type="button" className="btn btn-mini disabled:opacity-50" disabled={busy} onClick={exportAll}>
            <Icon name="download" size={13} /> {busy ? "Собираю…" : "Выгрузить все данные (JSON)"}
          </button>
          <div className="mono text-[10px] text-[#6e8492] mt-2">
            {journal.length} попыток · {storageBackend === "indexeddb" ? "IndexedDB" : "только память вкладки"}
          </div>
        </div>

        <div className="panel-soft p-3">
          <div className="text-[11px] font-bold text-[#e9f1f5] mb-1">Удаление данных</div>
          <div className="text-[11px] text-[#9bafbc] leading-relaxed mb-2.5">
            По требованию школы или родителя данные можно удалить полностью: журнал, оценки, правила, калибровку
            и настройки. Действие необратимо.
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-mini" onClick={onClearJournal}>
              <Icon name="trash" size={13} /> Очистить только попытки
            </button>
            <button type="button" className="btn btn-mini text-[#ff9494] border-[#ff6b6b]/40" onClick={wipeAll}>
              <Icon name="alert" size={13} /> Удалить все данные
            </button>
          </div>
        </div>
      </div>

      <details className="panel-soft p-3 mt-3">
        <summary className="text-[11px] font-bold text-[#d3e0e7] cursor-pointer">
          Что такое ODbL и когда нужен share-alike
        </summary>
        <div className="text-[11px] text-[#9bafbc] leading-relaxed mt-2">
          Данные OpenStreetMap распространяются под ODbL 1.0. Отображённая в тренажёре карта — «produced work»:
          достаточно атрибуции «© OpenStreetMap contributors», её можно показывать в своём оформлении. Если же
          школа выгружает и публикует изменённую базу данных OSM (например, собственную разметку площадок на
          основе OSM), действует условие share-alike: такую базу нужно предложить под той же ODbL. Собственные
          сценарии, оценки и записи заездов к OSM отношения не имеют.
        </div>
      </details>
    </div>
  );
}
