/**
 * @module App
 * @layer ui
 * @role Корневая оболочка вкладок, загрузка/сохранение настроек, связь с IndexedDB-журналом и сквозной подвал ODbL/дисклеймера.
 * @invariants #9 (атрибуция ODbL и дисклеймер на каждой вкладке), #15 (тренажёр остаётся смонтированным при смене вкладки), #16 (`unvalidated`).
 * @tests Смоук A–N (`tests/browser-smoke.mjs`)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnalyticsView } from "./components/AnalyticsView";
import { AuditView } from "./components/AuditView";
import { CustomScenarioView } from "./components/CustomScenarioView";
import { DebriefView } from "./components/DebriefView";
import { Icon } from "./components/Icons";
import { InstructorEditorView } from "./components/InstructorEditorView";
import { PrivacyLegalView } from "./components/PrivacyLegalView";
import { SimulatorView } from "./components/SimulatorView";
import { StrategyView } from "./components/StrategyView";
import { TestsAndModulesView } from "./components/TestsAndModulesView";
import type { NormalizedOsmPack } from "./maps/osmLoader";
import {
  customFromOsmPack,
  loadCustomScenario,
  saveCustomScenario,
  type CustomScenarioDef,
} from "./scenarios/custom";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET, type RuleSet } from "./scoring/rules";
import {
  JOURNAL_LIMIT,
  byNewest,
  joinAttempt,
  removeReview,
  splitAttempt,
  upsertJournal,
  upsertReview,
  type AttemptMeta,
} from "./sim/journal";
import type { InstructorReview, RecordedAttempt } from "./sim/recorder";
import { runAllSelfTests } from "./sim/selfTest";
import type { CalibrationConfig, ScenarioId } from "./sim/types";
import { normalizeWheelLock } from "./sim/vehicle";
import {
  clearJournalStore,
  initJournalStore,
  loadAttempt,
  loadAttempts,
  loadJournalMeta,
  saveAttempt,
  saveMeta,
  type JournalBackend,
} from "./storage/journalStore";

type TabId = "sim" | "custom" | "debrief" | "analytics" | "instructor" | "tests" | "audit";

const RULES_STORAGE = "cdt.ruleset.v1";
const CAL_STORAGE = "cdt.calibration.v1";
const STUDENT_STORAGE = "cdt.activeStudent.v1";
const INSTRUCTOR_STORAGE = "cdt.instructorName.v1";
const BLIND_STORAGE = "cdt.blindReview.v1";
/** Синтетические заезды из кнопки «Демо-попытка» не приписываются реальному ученику. */
const DEMO_STUDENT = "Демо (синтетика)";

function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeText(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // хранилище недоступно: настройка действует до закрытия вкладки
  }
}

function loadStoredRules(): RuleSet {
  try {
    const raw = localStorage.getItem(RULES_STORAGE);
    if (!raw) return DEFAULT_RULESET;
    const parsed = JSON.parse(raw) as Partial<RuleSet>;
    if (!parsed || !Array.isArray(parsed.rules)) return DEFAULT_RULESET;
    return { ...DEFAULT_RULESET, ...parsed, rules: parsed.rules };
  } catch {
    return DEFAULT_RULESET;
  }
}

function loadStoredCalibration(): CalibrationConfig {
  try {
    const raw = localStorage.getItem(CAL_STORAGE);
    if (!raw) return DEFAULT_CALIBRATION;
    const saved = JSON.parse(raw) as Partial<CalibrationConfig>;
    return { ...DEFAULT_CALIBRATION, ...saved, maxInnerWheelDeg: normalizeWheelLock(saved?.maxInnerWheelDeg) };
  } catch {
    return DEFAULT_CALIBRATION;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "неизвестная ошибка";
}

export default function App() {
  const [headerHidden, setHeaderHidden] = useState(false);
  const [tab, setTab] = useState<TabId>("sim");
  const [scenarioId, setScenarioId] = useState<ScenarioId>("bay_90");
  const [ruleSet, setRuleSet] = useState<RuleSet>(loadStoredRules);
  const [calibration, setCalibration] = useState<CalibrationConfig>(loadStoredCalibration);
  const [customOsm, setCustomOsm] = useState<NormalizedOsmPack | null>(null);
  const [rawCustomOsm, setRawCustomOsm] = useState<NormalizedOsmPack | null>(null);
  const [editorRawOsm, setEditorRawOsm] = useState<NormalizedOsmPack | null>(null);
  const [autoOpenRouteCheck, setAutoOpenRouteCheck] = useState<boolean>(false);
  const [customDef, setCustomDef] = useState<CustomScenarioDef>(loadCustomScenario);
  const [activeStudent, setActiveStudent] = useState<string>(() => readText(STUDENT_STORAGE) ?? "Ученик 1");
  const [instructorName, setInstructorName] = useState<string>(() => readText(INSTRUCTOR_STORAGE) ?? "");
  const [blindReview, setBlindReview] = useState<boolean>(() => readText(BLIND_STORAGE) === "1");

  // Журнал: в памяти — только лёгкая часть попыток; полная запись читается по требованию
  const [journal, setJournal] = useState<AttemptMeta[]>([]);
  const journalRef = useRef<AttemptMeta[]>([]);
  const [currentAttempt, setCurrentAttempt] = useState<RecordedAttempt | null>(null);
  const [storage, setStorage] = useState<{ ready: boolean; backend: JournalBackend; error: string | null }>({
    ready: false,
    backend: "indexeddb",
    error: null,
  });

  // Реальный результат автотестов для значка в навигации (а не зашитая строка)
  const [testBadge, setTestBadge] = useState<{ passed: number; total: number } | null>(null);

  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | null>(null);

  const notify = useCallback((msg: string, ms = 2800) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), ms);
  }, []);

  const applyJournal = useCallback((list: AttemptMeta[]) => {
    journalRef.current = list;
    setJournal(list);
  }, []);

  const reportStorageError = useCallback(
    (action: string, err: unknown) => {
      notify(`Журнал: не удалось ${action} — ${errorText(err)}`, 7000);
    },
    [notify]
  );

  useEffect(() => {
    try {
      localStorage.setItem(RULES_STORAGE, JSON.stringify(ruleSet));
    } catch {
      // storage blocked
    }
  }, [ruleSet]);

  useEffect(() => {
    try {
      localStorage.setItem(CAL_STORAGE, JSON.stringify(calibration));
    } catch {
      // storage blocked
    }
  }, [calibration]);

  useEffect(() => {
    saveCustomScenario(customDef);
  }, [customDef]);

  useEffect(() => writeText(STUDENT_STORAGE, activeStudent), [activeStudent]);
  useEffect(() => writeText(INSTRUCTOR_STORAGE, instructorName), [instructorName]);
  useEffect(() => writeText(BLIND_STORAGE, blindReview ? "1" : "0"), [blindReview]);

  // Открытие хранилища и перенос журнала прежней версии
  useEffect(() => {
    let alive = true;
    (async () => {
      const init = await initJournalStore();
      let metas: AttemptMeta[] = [];
      try {
        metas = await loadJournalMeta();
      } catch (err) {
        if (alive) reportStorageError("прочитать журнал", err);
      }
      if (!alive) return;

      // Попытки, сохранённые до конца загрузки, остаются в списке
      const known = new Set(journalRef.current.map((a) => a.id));
      applyJournal([...journalRef.current, ...metas.filter((a) => !known.has(a.id))].sort(byNewest));
      setStorage({ ready: true, backend: init.backend, error: init.error });

      if (init.backend === "memory") {
        notify("IndexedDB недоступна: журнал не сохранится после закрытия вкладки", 7000);
      } else if (init.migrated > 0) {
        notify(`Журнал перенесён в IndexedDB, попыток: ${init.migrated}`, 5000);
      }

      const newest = journalRef.current[0];
      if (newest) {
        try {
          const full = await loadAttempt(newest.id);
          if (alive && full) setCurrentAttempt((cur) => cur ?? full);
        } catch {
          // запись откроется по клику в журнале
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyJournal, notify, reportStorageError]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const results = runAllSelfTests();
        setTestBadge({ passed: results.filter((r) => r.passed).length, total: results.length });
      } catch {
        setTestBadge({ passed: 0, total: 0 });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);

  // Новая вкладка открывается с начала страницы, а не с позиции прокрутки предыдущей
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  const handleAttemptSaved = useCallback(
    (attempt: RecordedAttempt, openDebrief: boolean, quiet = false) => {
      const tagged: RecordedAttempt = {
        ...attempt,
        student: attempt.student ?? (activeStudent.trim() || undefined),
      };
      const parts = splitAttempt(tagged);
      // Повторное сохранение того же заезда (автосохранение, затем «Завершить → Разбор») обновляет запись
      const { list, evictedIds } = upsertJournal(journalRef.current, parts.meta, JOURNAL_LIMIT);
      const mergedMeta = list.find((a) => a.id === tagged.id) ?? parts.meta;
      const full = joinAttempt(mergedMeta, parts.payload);

      applyJournal(list);
      setCurrentAttempt(full);
      saveAttempt(full, evictedIds).catch((err) => reportStorageError("сохранить попытку на диск", err));

      if (openDebrief) {
        setTab("debrief");
      } else if (!quiet) {
        // Тихое сохранение во время заезда не должно всплывать уведомлениями
        notify(`Попытка сохранена в журнал: ${full.evaluation.verdict} (${full.evaluation.totalPoints} б.)`);
      }
    },
    [activeStudent, applyJournal, notify, reportStorageError]
  );

  /** Меняет лёгкую часть попытки (ученик, оценки инструкторов) в памяти и в хранилище. */
  const updateMeta = useCallback(
    (attemptId: string, change: (meta: AttemptMeta) => AttemptMeta) => {
      const existing = journalRef.current.find((a) => a.id === attemptId);
      if (!existing) return;
      const next = change(existing);
      applyJournal(journalRef.current.map((a) => (a.id === attemptId ? next : a)));
      setCurrentAttempt((cur) =>
        cur && cur.id === attemptId ? { ...cur, student: next.student, reviews: next.reviews } : cur
      );
      saveMeta(next).catch((err) => reportStorageError("сохранить изменения", err));
    },
    [applyJournal, reportStorageError]
  );

  const openAttempt = useCallback(
    (meta: AttemptMeta) => {
      loadAttempt(meta.id)
        .then((full) => {
          if (!full) {
            notify("Запись этой попытки не найдена в журнале");
            return;
          }
          setCurrentAttempt(full);
          setTab("debrief");
        })
        .catch((err) => reportStorageError("открыть попытку", err));
    },
    [notify, reportStorageError]
  );

  const clearJournal = useCallback(() => {
    const count = journalRef.current.length;
    if (count === 0) return;
    if (!window.confirm(`Удалить все попытки (${count}) вместе с оценками инструкторов? Отменить это нельзя.`)) {
      return;
    }
    applyJournal([]);
    setCurrentAttempt(null);
    clearJournalStore()
      .then(() => notify("Журнал попыток очищен"))
      .catch((err) => reportStorageError("очистить журнал", err));
  }, [applyJournal, notify, reportStorageError]);

  const loadAllAttempts = useCallback(() => loadAttempts(journalRef.current.map((a) => a.id)), []);

  const storageNote = !storage.ready
    ? "Журнал загружается…"
    : storage.backend === "indexeddb"
      ? `Хранится в этом браузере (IndexedDB): до ${JOURNAL_LIMIT} попыток с полной записью ввода`
      : "IndexedDB недоступна — журнал исчезнет после закрытия вкладки";

  const navItems: Array<{ id: TabId; label: string; short: string; icon: string; badge?: string; badgeTone?: "ok" | "bad" }> = [
    { id: "sim", label: "3D-Тренажёр", short: "Тренажёр", icon: "car" },
    { id: "custom", label: "Свой сценарий", short: "Сценарий", icon: "file" },
    {
      id: "debrief",
      label: "Разбор и Реплей", short: "Разбор",
      icon: "route",
      badge: journal.length > 0 ? String(journal.length) : undefined,
    },
    {
      id: "analytics",
      label: "Статистика", short: "Статистика",
      icon: "chart",
      badge: journal.length > 0 ? String(journal.length) : undefined,
    },
    { id: "instructor", label: "Инструктор и Правила", short: "Правила", icon: "sliders" },
    {
      id: "tests",
      label: "Тесты и Модули", short: "Тесты",
      icon: "cpu",
      badge: testBadge ? `${testBadge.passed}/${testBadge.total}` : undefined,
      badgeTone: testBadge && testBadge.total > 0 && testBadge.passed === testBadge.total ? "ok" : "bad",
    },
    { id: "audit", label: "План и стратегия", short: "План", icon: "layers" },
  ];

  return (
    <div className="relative min-h-screen flex flex-col">
      <div className="app-bg" />

      {/* Компактная верхняя шапка рабочей станции */}
      {headerHidden && <button type="button" data-testid="app-menu-show" className="fixed left-2 top-2 z-50 btn btn-mini" onClick={() => setHeaderHidden(false)}>☰ Показать верхнее меню</button>}
      <header style={headerHidden ? { display: "none" } : undefined} className="sticky top-0 z-40 border-b hairline bg-[#080d12]/92 backdrop-blur-md">
        <div className="mx-auto max-w-[1480px] px-4 sm:px-6 h-14 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTab("sim")}
            className="flex items-center gap-2.5 shrink-0 text-left"
          >
            <span className="h-8 w-8 rounded-lg bg-[#f5b942] text-[#17130a] grid place-items-center font-extrabold text-sm shadow-[0_0_20px_rgba(245,185,66,.28)]">
              C
            </span>
            <span className="hidden 2xl:block">
              <span className="block text-[13px] font-extrabold leading-none">CityDrivingTraining</span>
              <span className="block mono text-[9px] text-[#7c909d] mt-0.5">v0.3 MODULAR · OFFLINE</span>
            </span>
          </button>

          <nav className="flex items-center gap-1 overflow-x-auto scroll-thin flex-1 py-1">
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => setTab(item.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold whitespace-nowrap transition cursor-pointer ${
                    active
                      ? "bg-[#f5b942]/15 text-[#f5b942] border border-[#f5b942]/40"
                      : "text-[#9bafbc] hover:text-white hover:bg-white/[0.04] border border-transparent"
                  }`}
                >
                  <Icon name={item.icon} size={14} />
                  {/* На узких экранах — короткая подпись, полное название остаётся в подсказке */}
                  <span className="hidden min-[1340px]:inline">{item.label}</span>
                  <span className="min-[1340px]:hidden">{item.short}</span>
                  {item.badge && (
                    <span
                      className={`mono text-[10px] px-1.5 rounded-full ${
                        item.badgeTone === "ok"
                          ? "bg-[#52d6bd]/15 text-[#52d6bd]"
                          : item.badgeTone === "bad"
                            ? "bg-[#ff6b6b]/20 text-[#ff9494]"
                            : "bg-white/10 text-[#d3e0e7]"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <button type="button" data-testid="app-menu-hide" className="btn btn-mini shrink-0" aria-label="Скрыть верхнее меню" title="Скрыть верхнее меню" onClick={() => setHeaderHidden(true)}>−</button>
          <a
            href="https://github.com/FroloveD/CytyDrivingTraining"
            target="_blank"
            rel="noreferrer"
            className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-bold text-[#8fa2ae] hover:text-[#f5b942] shrink-0"
            title="Открыть репозиторий FroloveD/CytyDrivingTraining"
          >
            <Icon name="github" size={15} />
          </a>
        </div>
      </header>

      {/* Основная рабочая область */}
      <main className="relative z-10 flex-1 mx-auto w-full max-w-[1480px] px-4 sm:px-6 py-4">
        {/* Тренажёр остаётся примонтированным: переключение вкладок не прерывает заезд */}
        <div style={{ display: tab === "sim" ? "block" : "none" }}>
          <SimulatorView
            active={tab === "sim"}
            scenarioId={scenarioId}
            onScenarioChange={setScenarioId}
            calibration={calibration}
            onWheelLockChange={(angle) => setCalibration((prev) => ({ ...prev, maxInnerWheelDeg: normalizeWheelLock(angle) }))}
            ruleSet={ruleSet}
            customOsm={customOsm}
            rawCustomOsm={rawCustomOsm}
            onCustomOsmChange={(pack, rawPack) => {
              setCustomOsm(pack);
              if (rawPack !== undefined) setRawCustomOsm(rawPack);
            }}
            onEditOsmInEditor={(pack, rawPack) => {
              setCustomDef(customFromOsmPack(pack));
              setEditorRawOsm(rawPack ?? pack);
              setAutoOpenRouteCheck(true);
              setTab("custom");
              notify("Карта OSM перенесена в редактор: задайте произвольные границы и проверьте маршрут");
            }}
            customDef={customDef}
            onAttemptSaved={handleAttemptSaved}
            onNotify={notify}
          />
        </div>

        {tab === "custom" && (
          <CustomScenarioView
            def={customDef}
            onChange={setCustomDef}
            rawOsmPack={editorRawOsm}
            onRawOsmPackChange={setEditorRawOsm}
            autoOpenRouteCheck={autoOpenRouteCheck}
            onConsumeAutoOpenRouteCheck={() => setAutoOpenRouteCheck(false)}
            calibration={calibration}
            onOpenInSimulator={() => {
              setScenarioId("custom");
              setTab("sim");
              notify("Свой сценарий открыт в 3D-тренажёре (пункт 4)");
            }}
            onNotify={notify}
          />
        )}

        {tab === "debrief" && (
          <DebriefView
            currentAttempt={currentAttempt}
            journal={journal}
            journalLimit={JOURNAL_LIMIT}
            storageNote={storageNote}
            ruleSet={ruleSet}
            calibration={calibration}
            customDef={customDef}
            instructorName={instructorName}
            onInstructorNameChange={setInstructorName}
            blindReview={blindReview}
            onBlindReviewChange={setBlindReview}
            onSubmitReview={(attemptId: string, review: InstructorReview) =>
              updateMeta(attemptId, (meta) => upsertReview(meta, review))
            }
            onRemoveReview={(attemptId: string, instructor: string) =>
              updateMeta(attemptId, (meta) => removeReview(meta, instructor))
            }
            onSelectAttempt={openAttempt}
            onGenerateDemoAttempt={(att) => handleAttemptSaved({ ...att, student: DEMO_STUDENT }, true)}
            loadAllAttempts={loadAllAttempts}
            onClearJournal={clearJournal}
            onBackToSim={() => setTab("sim")}
            onNotify={notify}
          />
        )}

        {tab === "analytics" && (
          <AnalyticsView
            journal={journal}
            journalLimit={JOURNAL_LIMIT}
            storageReady={storage.ready}
            storageBackend={storage.backend}
            storageError={storage.error}
            ruleSet={ruleSet}
            activeStudent={activeStudent}
            onActiveStudentChange={setActiveStudent}
            onSelectAttempt={openAttempt}
            onUpdateStudent={(attemptId, student) =>
              updateMeta(attemptId, (meta) => ({ ...meta, student: student.trim() || undefined }))
            }
            onClearJournal={clearJournal}
            onOpenSimulator={() => setTab("sim")}
            onNotify={notify}
          />
        )}

        {tab === "instructor" && (
          <div className="space-y-5">
            <InstructorEditorView
              ruleSet={ruleSet}
              onRuleSetChange={setRuleSet}
              calibration={calibration}
              onCalibrationChange={setCalibration}
              onNotify={notify}
            />
            <PrivacyLegalView
              journal={journal}
              storageBackend={storage.backend}
              ruleSet={ruleSet}
              calibration={calibration}
              customDef={customDef}
              loadAllAttempts={loadAllAttempts}
              onClearJournal={clearJournal}
              onNotify={notify}
            />
          </div>
        )}

        {tab === "tests" && <TestsAndModulesView onNotify={notify} />}

        {tab === "audit" && (
          <div className="space-y-10">
            <StrategyView onNotify={notify} />
            <div className="pt-2 border-t hairline">
              <div className="mono text-[10px] text-[#7c909d] pt-6 pb-2">
                ИСТОРИЧЕСКИЙ АУДИТ ПРОТОТИПА v8 (АРХИВ ДО v0.2): РАСХОЖДЕНИЯ, ПРИОРИТЕТЫ, РИСКИ И ИСТОЧНИКИ
              </div>
              <AuditView onNotify={notify} onOpenSim={() => setTab("sim")} />
            </div>
          </div>
        )}

        {/* Дисклеймер и атрибуция видны на каждой вкладке */}
        <footer className="border-t hairline mt-6 pt-4 pb-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[11px] text-[#6e8492]">
          <span className="max-w-[70ch] leading-relaxed">
            Учебная симуляция: не является официальным экзаменом ГИБДД и не заменяет обучение с инструктором.
            Попытки, оценки и настройки хранятся только в этом браузере.
          </span>
          <span className="mono text-[10px]">© OpenStreetMap contributors · ODbL 1.0 · v0.3</span>
        </footer>
      </main>

      {toast && (
        <div
          data-testid="notification"
          role="status"
          aria-live="polite"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 panel px-4 py-2.5 text-[12px] font-bold text-[#52d6bd] shadow-2xl fade-in max-w-[92vw] pointer-events-none"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
