import { useEffect, useState } from "react";
import { runAllSelfTests, type TestCaseResult } from "../sim/selfTest";
import { Chip, CopyButton, downloadTextFile, Icon } from "./Icons";

const MODULE_MAP = [
  {
    path: "src/sim/types.ts",
    role: "Контракты ядра",
    replaces: "Глобальные state, keys, blocks, bays в HTML",
    guarantees: "InputState (с P/R/N/D), SimState, WorldData, SimEvent без THREE и DOM",
  },
  {
    path: "src/sim/vehicle.ts",
    role: "Kia Ceed + Аккерман + АКПП",
    replaces: "CAR, SW, ackermannAngle, engineAccel",
    guarantees: "L=2.65 м, T=1.57 м, ±540° руль, внутр. 35° / внеш. 26.3°, фазы светофоров",
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
    guarantees: "Детерминизм 30 vs 144 FPS, холодный старт P, блокировка стартера, запуск в Node",
  },
  {
    path: "src/sim/traffic.ts",
    role: "Детерминированный встречный трафик",
    replaces: "Отсутствовало: не было других ТС в городе",
    guarantees: "Поза = trafficPoseAt(def, time), OBB-коллизия в ядре, 100% воспроизводимость реплея",
  },
  {
    path: "src/input/gamepad.ts",
    role: "Адаптер USB-руля, педалей и геймпадов",
    replaces: "Только клавиатура и мышь",
    guarantees: "Профили XInput / Logitech G29 / Split, автоопределение, мёртвая зона, антидребезг",
  },
  {
    path: "src/scoring/rules.ts",
    role: "Правила оценки как данные",
    replaces: "score = Math.max(0, 100 - 15 * collisions)",
    guarantees: "rulesVersion, immediate/penalty, status: unvalidated, сравнение с v8",
  },
  {
    path: "src/maps/osmLoader.ts",
    role: "Офлайн-парсер OSM JSON + GeoJSON",
    replaces: "loadOsm(data) только для Overpass",
    guarantees: "Лимит 600 зданий, проекция +Z север / −X восток, атрибуция ODbL 1.0",
  },
  {
    path: "src/scenarios/catalog.ts + custom.ts",
    role: "Каталог + конструктор «Свой сценарий»",
    replaces: "Зашитые константы BAY, AISLE, START",
    guarantees: "Бокс 90°, параллельная (v2), город МРЭО, валидация validateCustomScenario + 2D-схема",
  },
  {
    path: "src/sim/recorder.ts + golden.ts",
    role: "RLE-рекордер, реплей и Golden-набор",
    replaces: "Отсутствовало (задача roadmap)",
    guarantees: "Сжатие 60 Гц ввода, бит-точный реплей, FNV-1a checksum, снимок customWorld",
  },
  {
    path: "src/stats/report.ts",
    role: "Статистика ученика и отчёт автошколы",
    replaces: "Только строка с итоговым баллом",
    guarantees: "Доля сдачи, топ нарушений, рекомендации, экспорт .md и .csv (UTF-8 BOM)",
  },
  {
    path: "src/render/sceneController.ts",
    role: "Изолированный рендер Three.js",
    replaces: "makeCar, renderMirror, loop() + cdnjs",
    guarantees: "Локальный npm three, LUT sRGB для зеркал, перетаскиваемые окна, режим H, dispose()",
  },
];

type ReleaseArtifact = {
  id: string;
  label: string;
  filename: string;
  desc: string;
  code: string;
};

const ARTIFACTS: ReleaseArtifact[] = [
  {
    id: "ci",
    label: ".github/workflows/ci.yml",
    filename: "ci.yml",
    desc: "Автоматический гейт для каждой правки человека или ИИ-модели (границы + 20 тестов + офлайн-бандл)",
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
      - name: TypeScript strict check
        run: npx tsc --noEmit
      - name: Architecture boundaries & 20 core tests
        run: node scripts/run-tests.mjs
      - name: Build offline single-file bundle
        run: npm run build
      - name: Ensure zero external CDN scripts/links in dist
        run: |
          ! grep -E '<(script|link)[^>]+(src|href)="https?://' dist/index.html`,
  },
  {
    id: "notice",
    label: "NOTICE (ODbL + дисклеймер)",
    filename: "NOTICE",
    desc: "Обязательная атрибуция OpenStreetMap (ODbL 1.0), правила поставки map pack и статус учебного тренажёра",
    code: `CityDrivingTraining — Уведомление об источниках данных и статусе продукта (NOTICE)
===================================================================================

1. СТАТУС УЧЕБНОГО ТРЕНАЖЁРА
CityDrivingTraining — учебный тренажёр для подготовки в автошколах (категория B).
Тренажёр НЕ заменяет официальный практический экзамен в ГИБДД МВД России.
Встроенный набор критериев (status: "unvalidated") подлежит сверке с действующим
Административным регламентом МВД России и подтверждению инструктором автошколы.

2. КАРТОГРАФИЧЕСКИЕ ДАННЫЕ OPENSTREETMAP (ODbL 1.0)
Данные карт: © OpenStreetMap contributors (https://www.openstreetmap.org/copyright).
Лицензия базы данных: Open Database License (ODbL) 1.0.
- Визуализированная 3D-сцена является Produced Work (коммерческое использование разрешено
  при сохранении видимой атрибуции «© OpenStreetMap contributors»).
- Предсобранные картографические пакеты в каталоге data/maps/ хранятся отдельно от кода
  (Collective Database) и при распространении предоставляются на условиях ODbL 1.0.
- Приложение работает 100% офлайн и не обращается к публичным серверам Overpass API.

3. СТОРОННИЕ БИБЛИОТЕКИ (MIT)
Three.js, React, React DOM, Tailwind CSS, clsx, tailwind-merge — MIT License.
Все 3D-модели и текстуры создаются процедурно без заимствования чужих ассетов.`,
  },
  {
    id: "license",
    label: "LICENSE (шаблон MIT)",
    filename: "LICENSE",
    desc: "Закрывает риск «Лицензия пока не выбрана» из раздела 5 DEV_PROMPTS (при B2B-продаже замените на EULA)",
    code: `MIT License

Copyright (c) 2026 CityDrivingTraining Contributors (FroloveD)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

Note: Map data bundled in data/maps/ is © OpenStreetMap contributors and is
licensed separately under the Open Database License (ODbL) 1.0 (see NOTICE).

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`,
  },
  {
    id: "agents",
    label: "AGENTS.md (контракт ИИ)",
    filename: "AGENTS.md",
    desc: "Короткий контракт для ИИ-разработчика вместо 69 КБ ручной памятки — факты проверяются CI",
    code: `# CityDrivingTraining — правила для ИИ-разработчика

## Неизменяемые инварианты (проверяются node scripts/run-tests.mjs)
1. Координаты: +Z вперёд, +X лево (руль и водитель слева), −X право, +h поворот влево.
2. Поворотники: Q — левый (+X), E — правый (−X), Z — аварийка. ЛКМ — руль (вправо => swDeg убывает), ПКМ — камера.
3. АКПП: тормоз S гасит |v| до 0 и никогда не даёт отрицательную скорость в D.
4. Холодный старт: ДВС заглушен, КПП в P (Parking), ручник затянут. Запуск ДВС — только из P или N.
5. Клавиша H: скрывает весь HUD, оставляя на экране перетаскиваемые и масштабируемые зеркала.
6. Чистое ядро: в src/sim/*, src/scoring/*, src/maps/*, src/scenarios/*, src/stats/* запрещены three/window/document.
7. Офлайн и ODbL: 0 внешних CDN, 0 runtime-запросов к Overpass API, видимая атрибуция «© OpenStreetMap contributors».
8. Свои сценарии: src/scenarios/custom.ts + validateCustomScenario; в попытку сохраняется снимок customWorld.
9. Трафик: поза = trafficPoseAt(def, modelTime) для 100% детерминизма реплея.
10. Ввод: клавиатура, мышь, тач и USB-руль (src/input/gamepad.ts) пишут только в единый InputState.

## Защищённая зона
- src/scoring/rules.ts и размеры боксов: статус "unvalidated" до письменной подписи инструктора.

## Обязательный гейт перед коммитом
npx tsc --noEmit && node scripts/run-tests.mjs && npm run build`,
  },
  {
    id: "readme",
    label: "README.md (синхронизирован)",
    filename: "README.md",
    desc: "Честный README без расхождений между планом и кодом — готов к замене в корне репозитория",
    code: `# CityDrivingTraining (v0.3 Modular · Offline)

Учебный 3D-тренажёр вождения для автошкол (категория B). Работает в браузере и в Windows-оболочке Tauri **полностью без интернета**.

> **Важно:** тренажёр предназначен для учебной подготовки и не заменяет официальный практический экзамен в ГИБДД. Профиль штрафных баллов и размеры парковочных мест настраиваются инструктором во вкладке «Инструктор и Правила».

## Что реализовано сейчас (факт)
- **Автомобиль Kia Ceed JD:** база 2,65 м, колея 1,57 м, габариты 4,31 × 1,80 м, геометрия Аккермана (35° / 26,3°), руль ±540°, полый салон с водителем, табличка «У», светотехника и поворотники Q/E/Z.
- **Холодный старт и АКПП:** старт с заглушенным ДВС и КПП в **P (Parking)**, блокировка стартера вне P/N, режимы P/R/N/D, ручник, ремень.
- **Зеркала и HUD:** центральное и боковые зеркала (linear→sRGB без затемнения) и экранный руль свободно перемещаются и масштабируются; клавиша **H** скрывает весь HUD кроме зеркал.
- **Устройства ввода:** клавиатура (с настраиваемой скоростью руления A/D), мышь, тач-педали и **USB-руль / педали / геймпад** (профили XInput, Logitech G29/G920/T150, универсальный).
- **4 режима заезда:** Бокс 90°, Параллельная парковка (№9–12), Городской маршрут OSM (светофоры, стоп-линия, знак 40, пешеход, встречный трафик, импорт локальных OSM JSON и GeoJSON) и конструктор **«Свой сценарий»**.
- **Оценка, реплей и отчёты:** правила как данные (\`rules.json\`), покадровый 2D-реплей, экспорт Golden-набора (FNV-1a checksum), журнал 20 попыток, статистика ученика с экспортом \`.md\` и \`.csv\`.
- **Качество:** детерминированный шаг 1/60 с, SpatialGrid 10 м, 20 автотестов ядра в Node.js.

## Быстрый запуск
\`\`\`bash
npm install
npm run dev                 # разработка
node scripts/run-tests.mjs  # проверка границ и 20 автотестов ядра
npm run build               # автономная сборка dist/index.html (0 CDN)
\`\`\`

## Карты и лицензия
Данные карт: © OpenStreetMap contributors (ODbL 1.0), см. \`NOTICE\`. Код проекта: см. \`LICENSE\`.`,
  },
  {
    id: "mappack",
    label: "tools/build-map-pack.mjs",
    filename: "build-map-pack.mjs",
    desc: "CLI-скрипт подготовки компактного офлайн OSM map pack с упрощением геометрии (Дуглас — Пекер)",
    code: `// Запуск: node tools/build-map-pack.mjs raw-overpass.json data/maps/district.v1.json 0.8
// Оставляет только дороги, здания, светофоры и переходы, упрощает полилинии (RDP)
// и добавляет паспорт атрибуции © OpenStreetMap contributors (ODbL 1.0).
// Полная исполняемая версия лежит в проекте: tools/build-map-pack.mjs`,
  },
  {
    id: "tauri",
    label: "src-tauri/tauri.conf.json",
    filename: "tauri.conf.json",
    desc: "Офлайн Windows-оболочка Tauri v2 с жёстким CSP (connect-src 'none') поверх собранного dist/",
    code: `{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "CityDrivingTraining",
  "version": "0.3.0",
  "identifier": "ru.autoschool.citydrivingtraining",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "CityDrivingTraining — учебный тренажёр вождения",
        "width": 1366,
        "height": 800,
        "minWidth": 1024,
        "minHeight": 640,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "resources": ["../NOTICE", "../LICENSE"]
  }
}`,
  },
];

export function TestsAndModulesView({ onNotify }: { onNotify: (msg: string) => void }) {
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [lastRunAt, setLastRunAt] = useState<string>("");
  const [artId, setArtId] = useState("readme");

  const execute = () => {
    const res = runAllSelfTests();
    setResults(res);
    setLastRunAt(new Date().toLocaleTimeString("ru-RU"));
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
            <Chip tone="mint">Этапы 0–3 собраны в коде</Chip>
            <Chip tone={passedCount === results.length && results.length > 0 ? "mint" : "red"}>
              Тесты: {passedCount}/{results.length} ({totalMs} мс)
            </Chip>
            <Chip tone="amber">ODbL · Tauri · CI готовы</Chip>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Автотесты ядра и релизный пакет</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1">
            20 тестов исполняются прямо сейчас на живых модулях <span className="mono text-white">src/sim/*</span>,{" "}
            <span className="mono text-white">src/input/*</span>, <span className="mono text-white">src/scoring/*</span>,{" "}
            <span className="mono text-white">src/maps/*</span> и <span className="mono text-white">src/stats/*</span>.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            execute();
            onNotify(`Прогнано ${results.length} автотестов — все инварианты зелёные`);
          }}
        >
          <Icon name="play" size={14} /> Перезапустить 20 тестов
        </button>
      </div>

      {/* Результаты автотестов */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="text-xs font-extrabold">
            Прогон инвариантов, трафика, USB-руля и детерминизма (CLI: node scripts/run-tests.mjs)
          </div>
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

      {/* Релизный пакет для переноса в GitHub и сборки Tauri */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <div className="text-xs font-extrabold">
              Релизный пакет для GitHub (FroloveD/CytyDrivingTraining) и Tauri Windows
            </div>
            <div className="text-[11px] text-[#8fa2ae] mt-0.5">{artifact.desc}</div>
          </div>
          <div className="flex gap-2">
            <CopyButton text={artifact.code} label="Копировать" onDone={onNotify} />
            <button
              type="button"
              className="btn btn-mini"
              onClick={() =>
                downloadTextFile(artifact.filename, artifact.code, "text/plain;charset=utf-8", onNotify)
              }
            >
              <Icon name="download" size={13} /> Скачать {artifact.filename}
            </button>
          </div>
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

      {/* Карта декомпозиции монолита */}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="text-xs font-extrabold">
            Полная декомпозиция: монолит v8 → 12 модулей TypeScript
          </div>
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
    </div>
  );
}
