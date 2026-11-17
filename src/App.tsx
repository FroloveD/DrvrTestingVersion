import { useCallback, useEffect, useRef, useState } from "react";
import { AuditView } from "./components/AuditView";
import { CustomScenarioView } from "./components/CustomScenarioView";
import { DebriefView } from "./components/DebriefView";
import { Icon } from "./components/Icons";
import { InstructorEditorView } from "./components/InstructorEditorView";
import { ReportsView } from "./components/ReportsView";
import { SimulatorView } from "./components/SimulatorView";
import { TestsAndModulesView } from "./components/TestsAndModulesView";
import type { NormalizedOsmPack } from "./maps/osmLoader";
import {
  loadCustomScenario,
  saveCustomScenario,
  type CustomScenarioDef,
} from "./scenarios/custom";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET, type RuleSet } from "./scoring/rules";
import {
  clearAttemptJournal,
  loadAttemptJournal,
  saveAttemptToJournal,
  type RecordedAttempt,
} from "./sim/recorder";
import type { CalibrationConfig, ScenarioId } from "./sim/types";

type TabId = "sim" | "custom" | "debrief" | "reports" | "instructor" | "tests" | "audit";

const RULES_STORAGE = "cdt.ruleset.v1";
const CAL_STORAGE = "cdt.calibration.v1";

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
    return { ...DEFAULT_CALIBRATION, ...(JSON.parse(raw) as Partial<CalibrationConfig>) };
  } catch {
    return DEFAULT_CALIBRATION;
  }
}

export default function App() {
  const [tab, setTab] = useState<TabId>("sim");
  const [scenarioId, setScenarioId] = useState<ScenarioId>("bay_90");
  const [ruleSet, setRuleSet] = useState<RuleSet>(loadStoredRules);
  const [calibration, setCalibration] = useState<CalibrationConfig>(loadStoredCalibration);
  const [customOsm, setCustomOsm] = useState<NormalizedOsmPack | null>(null);
  const [customDef, setCustomDef] = useState<CustomScenarioDef>(loadCustomScenario);
  const [journal, setJournal] = useState<RecordedAttempt[]>(loadAttemptJournal);
  const [currentAttempt, setCurrentAttempt] = useState<RecordedAttempt | null>(() => loadAttemptJournal()[0] ?? null);
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

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

  const handleAttemptSaved = useCallback(
    (attempt: RecordedAttempt, openDebrief: boolean) => {
      const updated = saveAttemptToJournal(attempt);
      setJournal(updated);
      setCurrentAttempt(attempt);
      if (openDebrief) {
        setTab("debrief");
      } else {
        notify(
          `Попытка сохранена в журнал: ${attempt.evaluation.verdict} (${attempt.evaluation.totalPoints} б.)`
        );
      }
    },
    [notify]
  );

  const navItems: Array<{ id: TabId; label: string; icon: string; badge?: string }> = [
    { id: "sim", label: "3D-Тренажёр", icon: "car" },
    { id: "custom", label: "Свой сценарий", icon: "file" },
    {
      id: "debrief",
      label: "Разбор и Реплей",
      icon: "route",
      badge: journal.length > 0 ? String(journal.length) : undefined,
    },
    { id: "instructor", label: "Инструктор и Правила", icon: "sliders" },
    { id: "reports", label: "Отчёты", icon: "chart", badge: journal.length > 0 ? String(journal.length) : undefined },
    { id: "tests", label: "Тесты и Релиз", icon: "cpu", badge: "20/20" },
    { id: "audit", label: "Аудит и План", icon: "layers" },
  ];

  return (
    <div className="relative min-h-screen flex flex-col">
      <div className="app-bg" />

      {/* Компактная верхняя шапка рабочей станции */}
      <header className="sticky top-0 z-40 border-b hairline bg-[#080d12]/92 backdrop-blur-md">
        <div className="mx-auto max-w-[1480px] px-4 sm:px-6 h-14 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTab("sim")}
            className="flex items-center gap-2.5 shrink-0 text-left"
          >
            <span className="h-8 w-8 rounded-lg bg-[#f5b942] text-[#17130a] grid place-items-center font-extrabold text-sm shadow-[0_0_20px_rgba(245,185,66,.28)]">
              C
            </span>
            <span className="hidden sm:block">
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
                  onClick={() => setTab(item.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold whitespace-nowrap transition cursor-pointer ${
                    active
                      ? "bg-[#f5b942]/15 text-[#f5b942] border border-[#f5b942]/40"
                      : "text-[#9bafbc] hover:text-white hover:bg-white/[0.04] border border-transparent"
                  }`}
                >
                  <Icon name={item.icon} size={14} />
                  <span>{item.label}</span>
                  {item.badge && (
                    <span
                      className={`mono text-[10px] px-1.5 py-0.2 rounded-full ${
                        item.id === "tests"
                          ? "bg-[#52d6bd]/15 text-[#52d6bd]"
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

          <a
            href="https://github.com/FroloveD/CytyDrivingTraining"
            target="_blank"
            rel="noreferrer"
            className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-bold text-[#8fa2ae] hover:text-[#f5b942] shrink-0"
            title="Открыть репозиторий FroloveD/CytyDrivingTraining"
          >
            <Icon name="github" size={15} />
            <span className="hidden xl:inline">GitHub</span>
          </a>
        </div>
      </header>

      {/* Основная рабочая область */}
      <main className="relative z-10 flex-1 mx-auto w-full max-w-[1480px] px-4 sm:px-6 py-4">
        {tab === "sim" && (
          <SimulatorView
            scenarioId={scenarioId}
            onScenarioChange={setScenarioId}
            calibration={calibration}
            ruleSet={ruleSet}
            customOsm={customOsm}
            onCustomOsmChange={setCustomOsm}
            customDef={customDef}
            onAttemptSaved={handleAttemptSaved}
            onNotify={notify}
          />
        )}

        {tab === "custom" && (
          <CustomScenarioView
            def={customDef}
            onChange={setCustomDef}
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
            ruleSet={ruleSet}
            calibration={calibration}
            customDef={customDef}
            onSelectAttempt={setCurrentAttempt}
            onGenerateDemoAttempt={(att) => handleAttemptSaved(att, true)}
            onClearJournal={() => {
              clearAttemptJournal();
              setJournal([]);
              setCurrentAttempt(null);
              notify("Журнал попыток очищен");
            }}
            onBackToSim={() => setTab("sim")}
            onNotify={notify}
          />
        )}

        {tab === "reports" && (
          <ReportsView
            journal={journal}
            ruleSet={ruleSet}
            calibration={calibration}
            onImportAsCustomScenario={(def) => {
              setCustomDef(def);
              setScenarioId("custom");
            }}
            onBackToSim={() => setTab("sim")}
            onNotify={notify}
          />
        )}

        {tab === "instructor" && (
          <InstructorEditorView
            ruleSet={ruleSet}
            onRuleSetChange={setRuleSet}
            calibration={calibration}
            onCalibrationChange={setCalibration}
            onNotify={notify}
          />
        )}

        {tab === "tests" && <TestsAndModulesView onNotify={notify} />}

        {tab === "audit" && <AuditView onNotify={notify} onOpenSim={() => setTab("sim")} />}
      </main>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 panel px-4 py-2.5 text-[12px] font-bold text-[#52d6bd] shadow-2xl fade-in">
          {toast}
        </div>
      )}
    </div>
  );
}
