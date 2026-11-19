/**
 * @module handoff
 * @layer pure-doc
 * @role Передача контекста в следующую сессию (единый источник правды для HANDOFF.md и вкладки «Тесты и Модули»).
 *
 * HANDOFF.md в корне генерируется командой `node scripts/write-handoff.mjs`, а совпадение проверяется
 * автоматически в `node scripts/run-tests.mjs` и в браузерном смоуке (сценарий N).
 */

/** Короткий блок — вставляется первым сообщением в новый чат. */
export const HANDOFF_PROMPT: string = [
  "Продолжаем CityDrivingTraining — офлайн 3D-тренажёр вождения (React 19 + Vite + Three.js 0.187, всё в одном dist/index.html).",
  "",
  "Прочитай целиком AGENTS.md, HANDOFF.md и WORKLOG.md в корне репозитория (при работе с ядром и рендером — docs/ARCHITECTURE.md и docs/ADR.md).",
  "",
  "Обязательный гейт перед любым ответом:",
  "  npx tsc --noEmit",
  "  ./node_modules/.bin/esbuild src/sim/selfTest.ts --bundle --platform=node --format=esm --outfile=/tmp/st.mjs --log-level=error && node --input-type=module -e \"const {runAllSelfTests}=await import('/tmp/st.mjs');const r=runAllSelfTests();console.log(r.filter(t=>!t.passed));if(r.some(t=>!t.passed))process.exit(1)\"",
  "  npm run build && node scripts/run-tests.mjs --check-dist",
  "",
  "Правила работы: правки точечные; src/sim, src/scoring, src/maps, src/scenarios, src/analytics, src/storage, src/strategy — без импортов three, window и document; ничего не загружаем из сети; правила оценки и размеры боксов не выдаём за норматив ГИБДД (статус unvalidated до подписи инструктора); package.json и vite.config.ts руками не правим; после каждого шага обновляем WORKLOG.md.",
  "",
  "Задача: <опиши задачу>",
].join("\n");

const L: string[] = [];

L.push("# CityDrivingTraining — передача контекста");
L.push("");
L.push("Документ для следующей сессии: что уже построено, какие правила нельзя нарушать, как проверять и что делать дальше.");
L.push("Источник правды — этот файл; он генерируется из `src/handoff.ts` командой `node scripts/write-handoff.mjs`.");
L.push("Обновляй документ вместе с кодом: расхождение инструкции и репозитория ломает работу модели сильнее, чем отсутствие инструкции.");
L.push("");

L.push("## 0. Промпт для вставки в новый чат");
L.push("");
L.push("```text");
L.push(HANDOFF_PROMPT);
L.push("```");
L.push("");

L.push("## 1. Что это и в каком состоянии");
L.push("");
L.push("Учебный тренажёр вождения для автошкол: площадка и город, оценка по правилам экзаменационного листа,");
L.push("разбор заезда с реплеем, статистика учеников, кабинет инструктора. Работает полностью офлайн.");
L.push("");
L.push("| Показатель | Значение |");
L.push("|---|---|");
L.push("| Продукт | одностраничное приложение, собирается в единственный `dist/index.html` (vite-plugin-singlefile) |");
L.push("| Стек | React 19.2, TypeScript 5.9, Vite 7.3, Tailwind 4.1, Three.js 0.187 (из npm, не CDN) |");
L.push("| Тесты ядра | 33 автотеста ядра (T01–T33), прогоняются и в Node, и во вкладке «Тесты и Модули» |");
L.push("| Браузерный смоук | `tests/browser-smoke.mjs`, сценарии A–P, >110 проверок (Playwright + headless Chromium, автозапуск в CI) |");
L.push("| Сеть | ноль внешних запросов в рантайме; данные ученика живут в браузере |");
L.push("| Вкладки | 3D-Тренажёр · Свой сценарий · Каталог маршрутов · Разбор и Реплей · Статистика · Инструктор и Правила · Тесты и Модули · План и стратегия |");
L.push("| Документация | `README.md` · `AGENTS.md` · `HANDOFF.md` · `WORKLOG.md` · `NOTICE` · `docs/ARCHITECTURE.md` · `docs/ADR.md` · `docs/CALIBRATION_GUIDE.md` · `docs/BRANCH_AUDIT.md` |");
L.push("");
L.push("Ядро детерминированное: шаг 1/60 с, одинаковый ввод даёт одинаковый заезд при 30 и 144 FPS,");
L.push("поэтому реплей, golden-набор и автотесты работают без браузера.");
L.push("");

L.push("## 2. Запуск и обязательная проверка");
L.push("");
L.push("```bash");
L.push("npm install");
L.push("npm run dev            # разработка");
L.push("npm run build          # прод: единственный самодостаточный dist/index.html");
L.push("```");
L.push("");
L.push("Гейт, который нужно проходить перед каждым ответом (все четыре шага):");
L.push("");
L.push("```bash");
L.push("# 1. Типы");
L.push("npx tsc --noEmit");
L.push("");
L.push("# 2. Автотесты ядра в чистом Node (без браузера, без three, без DOM)");
L.push("./node_modules/.bin/esbuild src/sim/selfTest.ts --bundle --platform=node --format=esm \\");
L.push("  --outfile=/tmp/st.mjs --log-level=error");
L.push("node --input-type=module -e \"const {runAllSelfTests}=await import('/tmp/st.mjs');\\");
L.push("const r=runAllSelfTests();console.log(r.filter(t=>!t.passed));if(r.some(t=>!t.passed))process.exit(1)\"");
L.push("");
L.push("# 3. Границы архитектуры: ядро не знает про рендер и DOM");
L.push("! grep -rlE \"from ['\\\"]three|window\\.|document\\.\" \\");
L.push("  src/sim src/scoring src/maps src/scenarios src/analytics src/storage src/strategy");
L.push("");
L.push("# 4. Сборка, автономность бандла и синхронность документации");
L.push("npm run build");
L.push("! grep -Eq '<(script|link)[^>]+(src|href)=\"https?://' dist/index.html");
L.push("node scripts/run-tests.mjs --check-dist   # единый раннер шагов 2–4 + проверка HANDOFF.md и docs/");
L.push("```");
L.push("");
L.push("Если менялся `src/handoff.ts`, перед гейтом пересобери корневой файл: `node scripts/write-handoff.mjs`.");
L.push("");
L.push("Браузерный смоук (нужен, если меняли HUD, раскладку, зеркала, педали, журнал или реплей):");
L.push("");
L.push("```bash");
L.push("npm i -D playwright && npx playwright install chromium");
L.push("# в Debian-подобных средах дополнительно: libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0");
L.push("# libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libasound2");
L.push("python3 -m http.server 4173 --bind 127.0.0.1 --directory dist &");
L.push("node tests/browser-smoke.mjs http://127.0.0.1:4173/index.html \\");
L.push("  \"file://$PWD/dist/index.html\" /tmp/cdt-shots");
L.push("```");
L.push("");
L.push("Смоук проверяет: холодный старт, вождение, реплей и детерминизм, сверку с инструктором, IndexedDB и перенос");
L.push("старого журнала, адаптер USB-руля на подставном устройстве, мышиное руление и газ по удержанию ЛКМ, раскладку на 1100/1366/1440 px, сохранение");
L.push("незавершённого заезда, правовой блок, перенос панелей долгим нажатием, раздельные педали, выворот 33–42°.");
L.push("");

L.push("## 3. Карта модулей");
L.push("");
L.push("| Путь | Роль |");
L.push("|---|---|");
L.push("| `src/sim/types.ts` | контракты: InputState, SimState, WorldData, SimEvent, CalibrationConfig |");
L.push("| `src/sim/vehicle.ts` | Kia Ceed: база 2,65 м, колея 1,57 м, Аккерман, выворот 33–42°, АКПП, фазы светофора, пешеход |");
L.push("| `src/sim/controls.ts` | чистые блокировки АКПП (`checkGearChange`) и стартера (`checkEngineToggle`) |");
L.push("| `src/sim/spatialGrid.ts` | сетка 10 м, OBB через SAT, insideBay, findBayLineCross, правый борт |");
L.push("| `src/sim/step.ts` | единственный шаг физики, детекторов и скоростных отрезков до перекрёстков; чистая функция, dt = 1/60 |");
L.push("| `src/sim/recorder.ts` | квантование ввода, RLE-запись, снапшот попытки, replayInputStream |");
L.push("| `src/sim/journal.ts` | разделение meta/payload, лимит 300 записей, оценки инструкторов |");
L.push("| `src/sim/golden.ts` | FNV-1a checksum, golden-набор (`cdt.golden.v1`) для сверки с инструктором |");
L.push("| `src/sim/selfTest.ts`, `src/sim/selfTestExtra.ts` | 33 автотеста ядра (T01–T33) |");
L.push("| `src/scoring/rules.ts` | правила как данные (verdict, баллы, immediate/penalty), DEFAULT_CALIBRATION |");
L.push("| `src/maps/osmLoader.ts`, `src/maps/osmXml.ts` | офлайн-парсер OSM XML/Overpass JSON/GeoJSON: oneway, roundabout, lanes/width, multipolygon, bounds, ODbL |");
L.push("| `src/maps/osmDeconflict.ts` | дорожные коридоры и согласование конфликтов дорог, зданий, ограждений, знаков и зон скорости |");
  L.push("| `src/maps/boundary.ts` | геометрия произвольных границ мира: шаблоны форм, проверка полигона, проекция автомобиля внутрь и обрезка по контуру |");
L.push("| `src/maps/route.ts` | сшивка сегментов, кандидаты и граф маршрутов с учётом oneway/layer, пространственная индексация и A* |");
L.push("| `src/maps/routeCatalog.ts` | построение/проверка OSM-маршрута, безопасный старт, повороты, редактирование КТ, fingerprint и снимок карты |");
L.push("| `src/scenarios/catalog.ts` | встроенные сценарии `bay_90`, `parallel_v2`, `city_osm` |");
L.push("| `src/scenarios/custom.ts` | редактор карт: схема, офлайн-импорт OSM/GeoJSON/JSON, валидация, сборка мира |");
L.push("| `src/scenarios/signs.ts`, `src/scenarios/editorOps.ts` | 12 классов знаков, 8 классов препятствий, операции 2D-холста (перенос, сетка, поворот, Undo/Redo) |");
L.push("| `src/render/sceneController.ts` | сцена, физические зеркала кабины через GPU Render Targets, камеры, адаптивный масштаб мира и качество |");
L.push("| `src/render/cityBuildings.ts` | процедурные фасады зданий РФ/СНГ, деревья и облачное небо |");
L.push("| `src/render/roadInfra.ts`, `src/render/roadTextures.ts` | PBR-дороги, тротуары, бордюры, разметка, знаки, светофоры и уличная инфраструктура ГОСТ |");
L.push("| `src/render/roadSignTextures.ts` | процедурные отражающие текстуры 12 классов дорожных знаков и дополнительные таблички |");
L.push("| `src/render/vehiclesAndPeds.ts` | детализированные машины, номерные знаки, приборная панель и анимированные пешеходы |");
L.push("| `src/input/gamepad.ts`, `src/input/browserGamepads.ts` | пошаговая калибровка USB-руля, AxisArming и чтение Gamepad API |");
L.push("| `src/analytics/summary.ts`, `src/analytics/calibration.ts` | статистика учеников, CSV, сводный отчёт Markdown, сверка вердиктов (ДИ Уилсона) |");
L.push("| `src/storage/journalStore.ts` | IndexedDB `cdt-journal` (meta + payload), миграция, деградация без падения |");
L.push("| `src/storage/routeCatalogStore.ts` | IndexedDB `cdt-route-catalog` v2: `routes` хранит маршруты, `maps` — общие OSM snapshot по fingerprint; миграция v1 → v2 |");
L.push("| `src/strategy/plan.ts` | фазы, принципы, приоритеты, журнал решений, экспорт strategy.md |");
L.push("| `src/components/RouteCatalogView.tsx` | выбор начала/конца на SVG-схеме OSM, проверка, сохранение, импорт/экспорт и открытие маршрута |");
L.push("| `src/App.tsx`, `src/components/*` | оболочка вкладок, плавающие панели HUD и экраны кабинета |");
L.push("| `src/data.ts` | исторический архив аудита монолита v8 (справка для вкладки «План и стратегия») |");
L.push("| `src/handoff.ts`, `scripts/write-handoff.mjs` | генератор этого документа (`HANDOFF.md`) и блока в UI |");
L.push("| `scripts/run-tests.mjs`, `tests/browser-smoke.mjs` | автогейт чистоты/тестов/доков в Node и Playwright-смоук A–P |");
L.push("| `tools/build-map-pack.mjs` | офлайн-сборщик компактного OSM map pack (упрощение Рамера — Дугласа — Пекера) |");
L.push("");

L.push("## 4. Инварианты — нарушать нельзя");
L.push("");
L.push("Проверяются автотестами; если задача требует изменить инвариант — сначала спроси пользователя.");
L.push("");
L.push("1. **Координаты**: +Z вперёд, +X — левый борт, −X — правый, положительный heading — поворот влево.");
L.push("2. **Поворотники**: Q — левый, E — правый, Z — аварийка; цикл 700 мс от model time. При начале движения на маршруте аварийка не заменяет Q/E.");
L.push("3. **Педали**: W — газ, S — тормоз. В D тормоз гасит скорость до 0 и никогда не даёт реверс.");
L.push("4. **КПП**: P / R / N / D (F). P блокирует движение и включается только на остановке; выход из P — при запущенном ДВС; запуск ДВС — только из P или N (`src/sim/controls.ts`).");
L.push("5. **Холодный старт**: ДВС заглушен, КПП в P, ручник затянут, ремень снят — при открытии и после «Сброс».");
L.push("6. **Фиксированный шаг** 1/60 с с аккумулятором; рендер интерполирует, физика — нет.");
L.push("7. **Чистое ядро**: в sim/scoring/maps/scenarios/analytics/storage/strategy запрещены three, window, document.");
L.push("8. **Офлайн**: никаких CDN и рантайм-запросов к Overpass; карта — встроенный пакет или локальный файл.");
L.push("9. **Атрибуция**: «© OpenStreetMap contributors» (ODbL 1.0) видна на экране и в подвале.");
L.push("10. **Руль**: полный ход ±540°; предел внутреннего колеса настраивается 33–42°, базовый 35°.");
L.push("    При 35° формула совпадает побитно со старыми записями — старые реплеи не должны разъехаться.");
L.push("11. **Выворот живёт в заезде**: каждый RLE-блок ввода хранит действовавший угол, реплей его применяет.");
L.push("12. **Мышь**: руление и газ (>400 мс ЛКМ) — независимые опции; руль выбирает режим свободного курсора или перетаскивания с ЛКМ, ПКМ — орбита, колесо — зум.");
L.push("13. **Зеркала**: HUD Canvas-зеркала остаются независимыми; в cockpit-режиме работают физические заднее и боковые зеркала через три GPU Render Targets, водитель скрывается.");
L.push("14. **HUD**: панели перетаскиваются за grip ⠿ или долгим нажатием 420 мс; педали — только за grip,");
L.push("    удержание самой кнопки нажимает педаль. H скрывает HUD, зеркала остаются.");
L.push("15. **Запись попытки**: `finished` — выполнено упражнение, `closed` — запись закрыта пользователем.");
L.push("    После закрытия ввод не пишется; новый заезд — только через «Сброс».");
L.push("16. **Оценка**: статус `unvalidated`, пока инструктор не подписал; не называть официальным экзаменом ГИБДД.");
L.push("");

L.push("## 5. Данные и ключи хранилища");
L.push("");
L.push("IndexedDB `cdt-journal`: store `meta` (лёгкие записи журнала) и `payload` (поток ввода, траектория,");
L.push("мир своего сценария, правила на момент заезда). Одна попытка — одна запись: повторное сохранение обновляет её.");
L.push("");
L.push("Отдельная IndexedDB `cdt-route-catalog` v2 содержит stores `routes` и `maps`: маршрут хранит геометрию, контрольные точки, ODbL-метаданные и `mapFingerprint`; общий snapshot карты хранится один раз в `maps` по fingerprint. Upgrade v1 → v2 атомарно переносит старые вложенные snapshot. При загрузке маршрут гидратируется до полной `cdt.route.v1`; экспорт `cdt.routes.v1.json` остаётся самодостаточным и включает snapshot. Snapshot удаляется только после удаления последнего маршрута, который на него ссылается; сервер и Overpass в рантайме не используются.");
L.push("");
L.push("localStorage:");
L.push("");
L.push("```text");
L.push("cdt.layout.v1           позиции и размеры плавающих панелей HUD");
L.push("cdt.controls.v1         скорость клавиш A/D, режимы руления мышью и опции мышиного газа");
L.push("cdt.calibration.v1      размеры боксов, выворот колёс, табличка «У»");
L.push("cdt.ruleset.v1          активный набор правил");
L.push("cdt.customScenario.v1   свой сценарий");
L.push("cdt.gamepad.profile.v2  включённое устройство, откалиброванные оси/педали, мёртвые зоны");
L.push("cdt.activeStudent.v1    активный ученик в кабинете инструктора");
L.push("cdt.instructorName.v1   имя инструктора для сверки");
L.push("cdt.blindReview.v1      слепой режим: вердикты скрыты до оценки");
L.push("cdt.strategy.v4         прогресс по следующим действиям стратегии");
L.push("cdt.licenseNote.v1      решение владельца по лицензии");
L.push("cdt-checklist-v1        чек-лист исторического аудита (AuditView)");
L.push("cdt.attempts.journal.v1 устаревший ключ: переносится в IndexedDB и удаляется");
L.push("cdt.gamepad.mapping.v1  устаревший ключ: удаляется при чтении профиля (заменён на cdt.gamepad.profile.v2)");
L.push("```");
L.push("");
L.push("Форматы выгружаемых JSON-файлов: `cdt.golden.v1` (golden-набор с FNV-1a checksum) и `cdt.backup.v1` (полная резервная копия кабинета).");
L.push("Все обращения к хранилищу — в try/catch: приватный режим или переполнение квоты не должны ронять заезд.");
L.push("");

L.push("## 6. Чего не делать");
L.push("");
L.push("- Не поднимать сервер, аккаунты и синхронизацию: данные остаются в браузере школы.");
L.push("- Не добавлять проверки и бенчмарки на школьном ПК (решение владельца); качество — автотесты и смоук.");
L.push("- Не править `package.json` и `vite.config.ts` вручную; зависимости — только через npm.");
L.push("- Не менять `src/scoring/rules.ts` и размеры боксов «по памяти о ПДД»: только данные + подпись инструктора.");
L.push("- Не вводить живой ИИ-трафик и случайности в физику: это сломает детерминизм, реплей и golden-набор.");
L.push("- Не добавлять новые упражнения, пока оценка не подтверждена инструктором.");
L.push("- Не обещать в текстах, что тренажёр заменяет экзамен в ГИБДД.");
L.push("");

L.push("## 7. Открытые задачи (по приоритету)");
L.push("");
L.push("**Сейчас — каталог экзаменационных маршрутов OSM**");
L.push("1. Дождаться результата полного Playwright A–P и устранить возможные регрессии.");
L.push("2. Проверить миграцию IndexedDB v1 → v2, совместное использование snapshot и удаление последней ссылки.");
L.push("3. Проверить маршруты, перенос КТ и фильтры на нескольких реальных OSM-картах: one-way, layer, длина и манёвры.");
L.push("4. Завершить аудит сложных перекрёстков, развязок, мостов/тоннелей, разрывов сети и границ импорта.");
L.push("");
L.push("**Дальше — качество и калибровка**");
L.push("4. Продолжить аудит сложных OSM-сцен: развязки, мосты/тоннели, разорванные сегменты и границы импорта.");
L.push("5. Снять 10–20 реальных заездов и получить вердикты 2–3 инструкторов; подписать набор правил `instructor_signed`.");
L.push("");
L.push("**Дальше — распространение**");
L.push("4. Выбрать LICENSE и условия распространения; поле для решения уже есть в правовом блоке.");
L.push("5. Tauri-сборка для Windows (конфиг-заготовка лежит во вкладке «Тесты и Модули»).");
L.push("6. Перенести модульную структуру, тесты, NOTICE и этот документ в репозиторий CytyDrivingTraining.");
L.push("7. Пилот в 1–2 автошколах, обратная связь по ощущениям от руля и педалей.");
L.push("");
L.push("**Потом — содержание**");
L.push("8. Новые упражнения: разворот в ограниченном пространстве, эстакада, змейка.");
L.push("9. Движущийся трафик как детерминированная функция model time (сейчас поток статичный).");
L.push("");

L.push("## 8. Как принимать задачу");
L.push("");
L.push("1. Прочитать `AGENTS.md`, этот документ, `WORKLOG.md` и затронутые модули целиком — не по памяти.");
L.push("2. Архитектурное решение зафиксировать в `docs/ADR.md` и одной строкой в `src/strategy/plan.ts`.");
L.push("3. Сначала контракт и тест: новое поведение покрыть кейсом в `selfTest*.ts` или проверкой в смоуке.");
L.push("4. Правки точечные, малыми порциями; в крупных файлах ориентироваться по якорям `[SEC:...]`.");
L.push("5. При изменении модулей/инвариантов/ключей обновить `src/handoff.ts` (`node scripts/write-handoff.mjs`) и `docs/ARCHITECTURE.md`.");
L.push("6. Обновить `WORKLOG.md` (статус, точка остановки, следующие шаги, техдолг `TD-*`), прогнать гейт из раздела 2 (и смоук при правках HUD).");
L.push("7. В ответе: что сделано, что проверено автоматически, что нужно проверить руками, какие остались долги.");
L.push("");

L.push("## 9. Что не проверено и известные долги");
L.push("");
L.push("Полный живой реестр техдолга со статусами ведётся в `WORKLOG.md` (раздел 4). Ключевые ограничения:");
L.push("");
L.push("- Реальный USB-руль и педали не подключались (`TD-09`): адаптер испытан на подставном устройстве через Gamepad API.");
L.push("- Tauri-сборка не выполнялась (`TD-10`): Windows-оболочку нужно собрать и проверить в целевой ОС.");
L.push("- Правила оценки и размеры боксов не подтверждены инструктором (`TD-07`) — статус `unvalidated` (протокол сверки: `docs/CALIBRATION_GUIDE.md`).");
L.push("- Файл `LICENSE` и условия распространения ждут решения владельца (`TD-08`).");
L.push("- Встроенный городской пакет — учебная схема квартала, трафик пока статичный (`TD-11`, см. `ADR-009` в `docs/ADR.md`).");
L.push("- HUD Canvas-зеркала обновляются с троттлингом (`TD-06`); физические зеркала кабины используют отдельные GPU Render Targets, освобождаемые при dispose.");
L.push("");

L.push("## 10. Стиль");
L.push("");
L.push("Интерфейс и комментарии — на русском; единицы — метры, радианы, секунды. Числовые значения в HUD —");
L.push("с фиксированным знакоместом (tabular-nums), чтобы показания не дёргались. Тёмная приборная палитра,");
L.push("янтарный акцент — предупреждение и активное состояние, мятный — успех и данные, красный — ошибка.");
L.push("Каждая новая панель HUD обязана быть перемещаемой и сохранять позицию в `cdt.layout.v1`.");
L.push("");
L.push("---");
L.push("");
L.push("Учебная симуляция. Не является официальным экзаменом ГИБДД и не заменяет обучение с инструктором.");
L.push("Данные карты: © OpenStreetMap contributors, ODbL 1.0.");

export const HANDOFF_MARKDOWN: string = L.join("\n");

/**
 * Байты файла HANDOFF.md. Генератор и выгрузка из интерфейса берут одну и ту же строку,
 * поэтому скачанный документ совпадает с файлом в репозитории побайтово.
 */
export const HANDOFF_FILE: string = HANDOFF_MARKDOWN + "\n";
