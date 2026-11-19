/**
 * @module components/TestsAndModulesView
 * @layer ui
 * @role Вкладка «Тесты и Модули»: запуск автотестов ядра в браузере, карта модулей, выгрузка `HANDOFF.md` и шаблоны CI/Tauri.
 * @tests Смоук A, N (`tests/browser-smoke.mjs`)
 */
import { useEffect, useState } from "react";
import { runAllSelfTests, type TestCaseResult } from "../sim/selfTest";
import { HANDOFF_FILE, HANDOFF_MARKDOWN, HANDOFF_PROMPT } from "../handoff";
import { Chip, CopyButton, downloadText, Icon } from "./Icons";

const MODULE_MAP = [
  {
    path: "src/sim/types.ts",
    role: "Контракты ядра",
    replaces: "Глобальные state, keys, blocks, bays в HTML",
    guarantees: "InputState, SimState, WorldData, SimEvent без THREE и DOM",
  },
  {
    path: "src/sim/vehicle.ts",
    role: "Kia Ceed + Аккерман + АКПП",
    replaces: "CAR, SW, ackermannAngle, engineAccel",
    guarantees: "База 2,65 м, колея 1,57 м, ход руля ±540°. Предел внутреннего колеса 33–42° (базовый 35°), внешнее — по Аккерману.",
  },
  {
    path: "src/sim/spatialGrid.ts",
    role: "Сетка 10 м + OBB SAT + боксы",
    replaces: "corners, carHits, bayRect, insideBay",
    guarantees: "O(1) соседние ячейки, детектор пересечения линии разметки findBayLineCross",
  },
  {
    path: "src/sim/step.ts",
    role: "Чистый шаг stepSimulation(1/60)",
    replaces: "update(dt) с побочными эффектами DOM",
    guarantees: "Детерминизм 30 vs 144 FPS, холодный старт P и парковочная блокировка, S не реверсирует в D, запуск в Node",
  },
  {
    path: "src/sim/controls.ts",
    role: "Блокировки АКПП и стартера ДВС",
    replaces: "Проверки передач внутри React-обработчиков",
    guarantees: "checkGearChange (P только на остановке, выход из P при ДВС) и checkEngineToggle (старт в P/N)",
  },
  {
    path: "src/maps/route.ts · src/maps/routeCheck.ts",
    role: "Маршрут по улицам OSM и диагностика",
    replaces: "Свободный проезд без проверки связности",
    guarantees: "Сшивка сегментов улиц, выбор/реверс улицы, поиск пути Дейкстрой, проверка КТ/препятствий и автопочинка",
  },
  {
    path: "src/maps/boundary.ts",
    role: "Произвольные границы маршрута и обрезка",
    replaces: "Жёсткий квадрат [-120..120] / [-600..600]",
    guarantees: "Многоугольник любой формы (до ±3000 м), коридор маршрута, оболочка улиц, обрезка дорог и удержание авто",
  },
  {
    path: "src/scoring/rules.ts",
    role: "Правила оценки как данные",
    replaces: "score = Math.max(0, 100 - 15 * collisions)",
    guarantees: "rulesVersion, immediate/penalty, status: unvalidated, сравнение с v8",
  },
  {
    path: "src/maps/osmLoader.ts · src/maps/osmXml.ts",
    role: "Офлайн-парсер .osm XML + Overpass JSON + GeoJSON",
    replaces: "loadOsm(data) только для Overpass JSON",
    guarantees: "Без DOMParser, лимит 600 зданий, дороги, знаки, заборы, деревья, проекция +Z север / −X восток, ODbL 1.0",
  },
  {
    path: "src/scenarios/custom.ts · signs.ts · editorOps.ts",
    role: "Интерактивный 2D-редактор карт и сценариев",
    replaces: "Жёстко зашитые координаты без правки",
    guarantees: "Импорт OSM/GeoJSON в редактор, 12 классов знаков, 8 препятствий, перенос по сетке, поворот и Undo/Redo",
  },
  {
    path: "src/scenarios/catalog.ts",
    role: "3 сценария как данные",
    replaces: "Зашитые константы BAY, AISLE, START",
    guarantees: "Бокс 90° (A/B), параллельная (порт v2, №9–12), город МРЭО с КТ",
  },
  {
    path: "src/scenarios/custom.ts",
    role: "Конструктор «Свой сценарий»",
    replaces: "Ручная правка кода под новое упражнение",
    guarantees: "validateCustomScenario, автодостройка авто, 2D-схема, экспорт JSON",
  },
  {
    path: "src/sim/recorder.ts",
    role: "RLE-рекордер, реплей и журнал",
    replaces: "Отсутствовало (задача roadmap)",
    guarantees: "Запись ровно того ввода, что получило ядро; точный реплей; экспорт golden JSON",
  },
  {
    path: "src/input/gamepad.ts",
    role: "Адаптер USB-руля и педалей",
    replaces: "Инвариант «только клавиатура», без внешних устройств",
    guarantees: "Выключен по умолчанию, калибровка по шагам, защита от ложного газа; на реальном руле не проверялся",
  },
  {
    path: "src/analytics/summary.ts",
    role: "Статистика учеников, CSV и Markdown",
    replaces: "Только мгновенный балл без истории",
    guarantees: "Доля сдавших, топ нарушений, успеваемость по ученикам, CSV для Excel и сводный отчёт .md",
  },
  {
    path: "src/strategy/plan.ts",
    role: "Стратегия как данные",
    replaces: "Разрозненные планы в README и промпт-памятке",
    guarantees: "Фазы, принципы, приоритеты, журнал решений, экспорт strategy.md",
  },
  {
    path: "src/sim/journal.ts + src/storage/journalStore.ts",
    role: "Журнал попыток в IndexedDB",
    replaces: "localStorage на 20 попыток с усечением записи ввода",
    guarantees: "До 300 попыток, полная запись ввода, одна запись на заезд, ошибки хранилища видны",
  },
  {
    path: "src/analytics/calibration.ts",
    role: "Сверка с инструктором",
    replaces: "Критерии «на глаз», без меры согласия",
    guarantees: "Доля совпадений вердиктов, цель 90 % при выборке от 20 оценок, виды расхождений",
  },
  {
    path: "src/render/sceneController.ts",
    role: "Изолированный рендер Three.js",
    replaces: "makeCar, renderMirror, loop() + cdnjs",
    guarantees: "Локальный npm three, полый салон, «У», 3 зеркала, отсечение зданий, dispose()",
  },
];

const ARTIFACTS = [
  {
    id: "ci",
    label: ".github/workflows/ci.yml",
    desc: "Автоматический гейт для каждой правки человека или ИИ-модели",
    code: `name: CityDrivingTraining CI
on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Typecheck
        run: npx tsc --noEmit
      - name: Core unit & determinism tests
        run: |
          ./node_modules/.bin/esbuild src/sim/selfTest.ts --bundle --platform=node \
            --format=esm --outfile=/tmp/st.mjs --log-level=error
          node --input-type=module -e "const {runAllSelfTests}=await import('/tmp/st.mjs');\
            const r=runAllSelfTests();if(r.some(t=>!t.passed)){console.log(r.filter(t=>!t.passed));process.exit(1)}"
      - name: Core boundaries (no three / window / document)
        run: |
          ! grep -rlE "from ['\\"]three|window\\.|document\\." \
            src/sim src/scoring src/maps src/scenarios src/analytics src/storage src/strategy
      - name: Production offline bundle
        run: npm run build
      - name: Fail if runtime CDN URLs leak into dist
        run: |
          ! grep -E "cdnjs\\.cloudflare\\.com|unpkg\\.com|jsdelivr\\.net|overpass-api\\.de" dist/index.html
      - name: Browser smoke (Playwright, headless Chromium)
        run: |
          npx playwright install --with-deps chromium
          python3 -m http.server 4173 --directory dist &
          node tests/browser-smoke.mjs http://127.0.0.1:4173/index.html "file://$PWD/dist/index.html" .smoke`,
  },
  {
    id: "agents",
    label: "AGENTS.md (вместо 69 КБ промпта)",
    desc: "Короткий контракт для ИИ-модели — факты живут в типах и тестах",
    code: `# CityDrivingTraining — правила для ИИ-разработчика

## Неизменяемые инварианты (проверяются src/sim/selfTest.ts)
1. Координаты: +Z вперёд, +X лево (руль и водитель слева), −X право, +h поворот влево.
2. Поворотники: Q — левый (+X), E — правый (−X), Z — аварийка (не заменяет Q/E на старте маршрута). ЛКМ — руль (вправо => swDeg убывает), ПКМ — камера.
3. АКПП (src/sim/controls.ts): тормоз S гасит |v| до 0 и никогда не даёт реверс в D; P — только на остановке, выход из P при ДВС.
4. Холодный старт: ДВС заглушен, КПП в P (Parking), ручник затянут. Запуск ДВС — только из P/N.
5. Чистое ядро: в src/sim, src/scoring, src/maps, src/scenarios, src/analytics, src/storage, src/strategy запрещены three, window и document.
6. Офлайн: никаких внешних CDN и runtime-вызовов публичного Overpass API.
7. Атрибуция карт: «© OpenStreetMap contributors» (ODbL 1.0) видна на экране.
8. Проверку на школьном ПК не добавляем: только автотесты и offline/perf-smoke в CI.
9. Свои сценарии: только через src/scenarios/custom.ts + validateCustomScenario, мир в попытке — снимок customWorld.
10. Запись ввода: рекордер хранит ровно то, что получило ядро; квантование — только до шага симуляции.
11. USB-устройства выключены по умолчанию; раскладку рулей не угадывать — только калибровка по шагам.
12. Журнал: IndexedDB через src/storage/journalStore.ts; ошибки хранилища показывать пользователю.
13. Выворот колёс настраивается 33–42° (базовый 35°); при 35° формула совпадает побитно со старыми
    записями. Действовавший угол хранится в каждом RLE-блоке ввода — реплей применяет его.
14. Зеркала: заднее 320×96 (10:3), боковые 320×160 (2:1), независимые переключатели и render targets.
15. HUD перемещается за grip или долгим нажатием 420 мс; педали — только за grip, удержание кнопки
    нажимает педаль. Позиции живут в cdt.layout.v1.
16. finished — упражнение выполнено, closed — запись закрыта; после closed ввод не пишется.

## Защищённые зоны
- src/scoring/rules.ts и размеры боксов: не выдавать за «официальный норматив ГИБДД»;
  статус остаётся "unvalidated" до подписи инструктора.

## Обязательная проверка перед ответом
1. npx tsc --noEmit
2. Автотесты ядра: esbuild src/sim/selfTest.ts --bundle --platform=node --format=esm, затем прогон
   runAllSelfTests() в node (полная команда — в HANDOFF.md, раздел 2).
3. npm run build и node scripts/run-tests.mjs --check-dist (чистота ядра, тесты, синхронность HANDOFF/docs, офлайн dist/index.html).
4. Обновить WORKLOG.md; при правках HUD, зеркал, педалей, журнала или реплея — node tests/browser-smoke.mjs.`,
  },
  {
    id: "notice",
    label: "NOTICE (атрибуция и дисклеймер)",
    desc: "Фиксирует атрибуцию ODbL и учебный характер продукта — класть в корень репозитория",
    code: `CityDrivingTraining — учебный тренажёр вождения.\n\nНЕ является официальным экзаменом ГИБДД и не заменяет обучение с инструктором.\n\nКартографические данные: © OpenStreetMap contributors, распространяются под ODbL 1.0.\nОтображённая карта в тренажёре — Produced Work (достаточно атрибуции на экране).\nЕсли вы публикуете производную базу данных OSM, она распространяется под ODbL 1.0 (share-alike).\n\nДанные учеников (ФИО, записи заездов, вердикты инструкторов) хранятся локально в браузере\n(IndexedDB и localStorage) и никуда не передаются приложением. Выгрузка CSV / JSON / golden-набора\nсодержит персональные данные — храните и передавайте их по правилам вашей школы.\n\nЛицензия исходного кода: пока не выбрана владельцем продукта (см. раздел\n«Данные, атрибуция и лицензии» в приложении).`,
  },
  {
    id: "tauri",
    label: "src-tauri/tauri.conf.json (Windows)",
    desc: "Лёгкая офлайн-оболочка для ПК автошкол поверх того же dist/",
    code: `{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "CityDrivingTraining",
  "version": "0.2.0",
  "identifier": "ru.autoschool.citydrivingtraining",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      { "title": "CityDrivingTraining — учебный тренажёр", "width": 1366, "height": 768, "resizable": true }
    ],
    "security": {
      "csp": "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'"
    }
  }
}`,
  },
];

export function TestsAndModulesView({ onNotify }: { onNotify: (msg: string) => void }) {
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [lastRunAt, setLastRunAt] = useState<string>("");
  const [artId, setArtId] = useState("ci");
  // Заголовки разделов берём из самого документа — список не может с ним разойтись
  const handoffSections = HANDOFF_MARKDOWN.split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).replace(/^\d+\.\s*/, ""));

  const execute = () => {
    const res = runAllSelfTests();
    setResults(res);
    setLastRunAt(new Date().toLocaleTimeString("ru-RU"));
    return res;
  };

  useEffect(() => {
    execute();
  }, []);

  const passedCount = results.filter((r) => r.passed).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0).toFixed(1);
  const artifact = ARTIFACTS.find((a) => a.id === artId) ?? ARTIFACTS[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="mint">Этапы 0–2 реализованы в коде</Chip>
            <Chip tone={passedCount === results.length && results.length > 0 ? "mint" : "red"}>
              Тесты: {passedCount}/{results.length} ({totalMs} мс)
            </Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Автотесты ядра и модульная архитектура</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1">
            Эти тесты выполняются прямо сейчас на живых модулях <span className="mono text-white">src/sim/*</span>,{" "}
            <span className="mono text-white">src/scoring/*</span> и <span className="mono text-white">src/maps/*</span>,
            которые крутят 3D-тренажёр.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            const res = execute();
            const failedCount = res.filter((r) => !r.passed).length;
            onNotify(
              failedCount === 0
                ? `Тесты пройдены: ${res.length} из ${res.length}`
                : `Не пройдено тестов: ${failedCount} из ${res.length}`
            );
          }}
        >
          <Icon name="play" size={14} /> Перезапустить тесты ({results.length})
        </button>
      </div>

      {/* Результаты автотестов */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="text-xs font-extrabold">Прогон инвариантов и детерминизма (вместо одного node --check)</div>
          <span className="mono text-[10px] text-[#7c909d]">
            Последний запуск: {lastRunAt} · суммарно {totalMs} мс
          </span>
        </div>
        <div className="grid md:grid-cols-2 gap-2.5">
          {results.map((t) => (
            <div
              key={t.id}
              className={`panel-soft p-3 border ${
                t.passed ? "border-[#52d6bd]/25" : "border-[#ff6b6b]/60 bg-[#ff6b6b]/10"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`h-4 w-4 rounded-full grid place-items-center text-[10px] font-bold ${
                    t.passed ? "bg-[#52d6bd]/20 text-[#52d6bd]" : "bg-[#ff6b6b] text-black"
                  }`}
                >
                  {t.passed ? "✓" : "!"}
                </span>
                <span className="mono text-[10px] text-[#f5b942]">{t.id}</span>
                <span className="mono text-[10px] text-[#6e8492]">{t.suite}</span>
                <span className="mono text-[10px] text-[#7c909d] ml-auto">{t.durationMs} мс</span>
              </div>
              <div className="text-[12px] font-bold text-[#e9f1f5] leading-snug">{t.name}</div>
              <div className="mono text-[10px] text-[#8fa2ae] mt-1 leading-relaxed">{t.detail}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Карта декомпозиции монолита */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="text-xs font-extrabold">Реализованная декомпозиция: монолит v8 → модули TypeScript</div>
          <Chip tone="amber">0 CDN · 100% офлайн</Chip>
        </div>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-left text-[12px]">
            <thead className="mono text-[10px] text-[#6e8492] border-b hairline">
              <tr>
                <th className="py-2 pr-3">Модуль</th>
                <th className="py-2 pr-3">Назначение</th>
                <th className="py-2 pr-3">Что заменяет в v8</th>
                <th className="py-2">Что гарантирует</th>
              </tr>
            </thead>
            <tbody>
              {MODULE_MAP.map((m) => (
                <tr key={m.path} className="border-b hairline last:border-0">
                  <td className="py-2.5 pr-3 mono text-[11px] text-[#52d6bd] whitespace-nowrap">{m.path}</td>
                  <td className="py-2.5 pr-3 font-semibold">{m.role}</td>
                  <td className="py-2.5 pr-3 text-[#8fa2ae] text-[11px]">{m.replaces}</td>
                  <td className="py-2.5 text-[#cbd5e1] text-[11px]">{m.guarantees}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Передача контекста в следующую сессию */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="max-w-[70ch]">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <div className="text-xs font-extrabold">Передача контекста в следующий чат</div>
              <Chip tone="mint">{handoffSections.length} разделов</Chip>
              <Chip tone="neutral">{(HANDOFF_MARKDOWN.length / 1024).toFixed(1)} КБ</Chip>
            </div>
            <p className="text-[11px] text-[#9bafbc] leading-relaxed">
              Один документ вместо пересказа истории: карта модулей, инварианты, точные команды гейта,
              ключи хранилища, открытые задачи и то, что осталось непроверенным. <span className="mono text-[#c9d7de]">HANDOFF.md</span> в
              корне генерируется из <span className="mono text-[#c9d7de]">src/handoff.ts</span> — правь модуль, а не оба файла.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={HANDOFF_PROMPT} label="Короткий промпт" onDone={onNotify} />
            <CopyButton text={HANDOFF_MARKDOWN} label="Весь документ" onDone={onNotify} />
            <button type="button" className="btn btn-primary btn-mini"
              onClick={() => downloadText("HANDOFF.md", HANDOFF_FILE, onNotify)}>
              <Icon name="download" size={13} /> HANDOFF.md
            </button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.05fr_.95fr] gap-4 items-start">
          <div className="panel-soft p-3.5">
            <div className="mono text-[10px] text-[#6e8492] mb-2">СОСТАВ ДОКУМЕНТА</div>
            <ol className="space-y-1.5">
              {handoffSections.map((title, index) => (
                <li key={title} className="flex items-baseline gap-2 text-[11.5px] text-[#c9d7de]">
                  <span className="mono text-[10px] text-[#f5b942] shrink-0">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{title}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="panel-soft p-3.5">
            <div className="flex items-center justify-between mb-2">
              <span className="mono text-[10px] text-[#6e8492]">КОРОТКИЙ ПРОМПТ</span>
              <span className="mono text-[10px] text-[#52d6bd]">{HANDOFF_PROMPT.split("\n").length} строк</span>
            </div>
            <pre className="mono text-[10.5px] leading-[1.7] text-[#b9c9d3] max-h-[210px] overflow-auto scroll-thin whitespace-pre-wrap">{HANDOFF_PROMPT}</pre>
            <p className="text-[10.5px] text-[#8fa2ae] leading-relaxed mt-2.5 pt-2.5 border-t hairline">
              Вставь этот блок первым сообщением и допиши задачу. Модель прочитает HANDOFF.md сама —
              пересказывать историю чата не нужно.
            </p>
          </div>
        </div>
      </div>

      {/* Готовые конфиги для переноса в GitHub-репозиторий */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <div className="text-xs font-extrabold">Готовые конфиги для переноса в CytyDrivingTraining</div>
            <div className="text-[11px] text-[#8fa2ae] mt-0.5">{artifact.desc}</div>
          </div>
          <CopyButton text={artifact.code} label="Скопировать файл" onDone={onNotify} />
        </div>
        <div className="segmented flex-wrap mb-3">
          {ARTIFACTS.map((a) => (
            <button key={a.id} type="button" className={artId === a.id ? "on" : ""} onClick={() => setArtId(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
        <div className="panel-soft p-4">
          <pre className="mono text-[11px] leading-[1.65] text-[#cfe0e8] overflow-x-auto scroll-thin whitespace-pre">
            {artifact.code}
          </pre>
        </div>
      </div>
    </div>
  );
}
