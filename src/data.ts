/**
 * @module data
 * @layer ui-archive
 * @role ИСТОРИЧЕСКИЙ СРЕЗ АУДИТА МОНОЛИТА v8 (до модульной переработки v0.2/v0.3) для вкладки «План и стратегия» (AuditView).
 *
 * ВАЖНО ДЛЯ РАЗРАБОТЧИКОВ И ИИ-АГЕНТОВ:
 * Описания проблем ниже («Three.js r128 тянется с cdnjs», «всё в одном HTML», «нет реплея» и т. п.)
 * фиксируют ИСХОДНОЕ состояние старого прототипа и НЕ описывают текущий код репозитория!
 * Актуальное состояние архитектуры, инвариантов, тестов и техдолга см. в:
 *   - HANDOFF.md (генерируется из src/handoff.ts)
 *   - AGENTS.md, WORKLOG.md, docs/ARCHITECTURE.md, docs/ADR.md
 */
export type Tier = "P0" | "P1" | "P2";

export type Improvement = {
  id: string;
  title: string;
  tier: Tier;
  category: string;
  impact: number; // 1..10
  effort: number; // 1..10
  duration: string;
  problem: string;
  actions: string[];
  artifact: string;
  done: string;
};

export const improvements: Improvement[] = [
  {
    id: "offline",
    title: "Убрать CDN и обеспечить реальный офлайн",
    tier: "P0",
    category: "Инфраструктура",
    impact: 9,
    effort: 2,
    duration: "0,5–1 день",
    problem:
      "Three.js r128 тянется с cdnjs, хотя README обещает проверку «работы без интернета». В школах сеть часто закрыта — сцена просто не стартует.",
    actions: [
      "Перенести Three.js в npm и собирать проект через Vite",
      "Проверить dist с отключённой сетью в DevTools, убрать все внешние URL",
      "Добавить в CI сборку и проверку бандла на внешние запросы",
    ],
    artifact: "package.json · vite.config.ts · scripts/check-offline.mjs",
    done: "Сцена запускается без сети, в бандле нет запросов к CDN",
  },
  {
    id: "rules",
    title: "Правила оценки как версионируемые данные",
    tier: "P0",
    category: "Оценка",
    impact: 10,
    effort: 3,
    duration: "2–3 дня",
    problem:
      "В коде `score = 100 − 15 × collisions`. Одно касание даёт 85/100, хотя в экзаменационном листе сбитый конус или пересечение линии разметки — критическая ошибка, прекращающая экзамен. Шкала не соответствует даже логике «сдал / не сдал».",
    actions: [
      "Вынести правила в JSON: id, points, тип (immediate | penalty), формулировка, источник, effectiveFrom",
      "Сделать движок чистой функцией evaluate(events, rules) → verdict",
      "Показывать ученику текст нарушения и версию правил, а не только число",
    ],
    artifact: "src/scoring/rules/ru.demo.json · src/scoring/evaluate.ts",
    done: "Правила меняются без правки кода; каждая попытка хранит rulesVersion",
  },
  {
    id: "core",
    title: "Чистое ядро симуляции и фиксированный шаг",
    tier: "P0",
    category: "Ядро",
    impact: 9,
    effort: 4,
    duration: "3–5 дней",
    problem:
      "Физика, ввод, DOM и THREE перемешаны в update(dt); dt приходит из requestAnimationFrame (до 50 мс). Траектория и столкновения зависят от FPS — результат нельзя воспроизвести.",
    actions: [
      "Ввести единый контракт InputState { throttle, brake, steering, gear, signals }",
      "Вынести step(state, input, dt) в модуль без THREE и DOM",
      "Фиксированный шаг 1/60 с аккумулятором, рендер с интерполяцией",
    ],
    artifact: "src/core/step.ts · src/core/types.ts · src/core/loop.ts",
    done: "Одинаковый ввод даёт одинаковую траекторию при 30 и 144 FPS; ядро запускается в Node",
  },
  {
    id: "tests",
    title: "Автотесты вместо только `node --check`",
    tier: "P0",
    category: "Качество",
    impact: 9,
    effort: 3,
    duration: "2–3 дня",
    problem:
      "Сейчас проверка — синтаксис, сканер идентификаторов и ручной чеклист. В разделе 5 DEV_PROMPTS прямо указано: «Не проверено в браузере». Это главный источник скрытых регрессий при правках моделью.",
    actions: [
      "Vitest: кинематика, инварианты координат, insideBay, carHits, движок баллов",
      "Golden-набор: 10 эталонных заездов с вердиктами инструктора",
      "Playwright smoke: сцена, заезд в бокс, загрузка OSM-пакета",
    ],
    artifact: "tests/*.test.ts · tests/golden/*.json",
    done: "npm test зелёный до каждого релиза; регрессии ловятся до ручной проверки",
  },
  {
    id: "validation",
    title: "Калибровка критериев с инструкторами",
    tier: "P0",
    category: "Продукт",
    impact: 10,
    effort: 5,
    duration: "1–2 недели",
    problem:
      "Размеры бокса 2,5 × 5,3 м и проезд 6 м помечены «предварительно», список ошибок отсутствует. В открытых источниках описания действующего регламента и состава упражнений расходятся — модель не может быть авторитетом здесь.",
    actions: [
      "Зафиксировать версию административного регламента / приложения №4, дату и источник в rules.json",
      "Снять 10–20 видеозаездов, получить вердикты 2–3 инструкторов, сделать эталонную выборку",
      "Явный статус «учебный тренажёр» в UI и в маркетинге; терминология ГИБДД, не «замена экзамена»",
    ],
    artifact: "docs/validation-protocol.md · docs/adr/0003-scoring-source.md",
    done: "≥90% совпадения вердикта симулятора с инструкторами на эталонной выборке",
  },
  {
    id: "ai",
    title: "ИИ-разработка через контракты и гейты",
    tier: "P0",
    category: "Процесс",
    impact: 8,
    effort: 3,
    duration: "2 дня",
    problem:
      "DEV_PROMPTS.md на 69 КБ стал вторым источником истины и уже разошёлся с кодом: документ ссылается на DrivingSim_OSM_layers_v8.html, а в репозитории лежит DrivingSim_Merged_v8_ackermann.html.",
    actions: [
      "Заменить «памятку на всё» на короткие ADR + SPEC + CHANGELOG рядом с кодом",
      "Модель генерирует тесты, сценарии и рефакторинг, но не меняет scoring без подписи человека",
      "Обязательный CI-конвейер: node --check → типы → тесты → Playwright",
    ],
    artifact: "CONTRIBUTING.md · docs/adr/* · .github/workflows/ci.yml",
    done: "Любая правка от модели проходит одни и те же автоматические гейты и малые PR",
  },
  {
    id: "modules",
    title: "Разделить монолит по границам модулей",
    tier: "P1",
    category: "Архитектура",
    impact: 10,
    effort: 6,
    duration: "1 неделя",
    problem:
      "131 КБ и ~1500 строк в одном `<script>`, около 60 глобальных функций. README описывает структуру src/input, src/vehicle, src/scoring, но её в репозитории нет. Любая «точечная правка» модели задевает HUD, зеркала и физику.",
    actions: [
      "Strangler-подход: сначала механически вынести `<script>` в ES-модули, не меняя логику",
      "Затем зафиксировать границы input / vehicle / world / scenarios / scoring / render / ui",
      "Убрать глобалы, добавить TypeScript-типы и явные контракты между слоями",
    ],
    artifact: "src/* (структура из README, наконец реализованная)",
    done: "Правка оценки не трогает рендер; типичный diff задачи < 100 строк",
  },
  {
    id: "replay",
    title: "Запись ввода и воспроизводимый реплей",
    tier: "P1",
    category: "Ядро",
    impact: 8,
    effort: 4,
    duration: "3–4 дня",
    problem:
      "Попытка не сохраняется: нельзя доказать, почему начислен балл, повторить спорный заезд или превратить баг в тест.",
    actions: [
      "Писать seed + поток InputState по шагам + события + rulesVersion",
      "Реплей как инструмент инструктора и как регрессионный тест",
      "Экспорт JSON попытки для разбора и поддержки",
    ],
    artifact: "src/core/recorder.ts · src/core/replay.ts",
    done: "Спорная попытка воспроизводится покадрово и добавляется в golden-набор",
  },
  {
    id: "osm",
    title: "OSM как офлайн map pack, а не runtime-запрос",
    tier: "P1",
    category: "Данные",
    impact: 9,
    effort: 6,
    duration: "1 неделя",
    problem:
      "README заявляет Overpass API, но код лишь загружает готовый OSM JSON из файла или URL. Публичный Overpass — volunteer-инфраструктура: для регулярного использования ~100 запросов/день, коммерческим продуктам рекомендуют свой/платный инстанс.",
    actions: [
      "Build-time пайплайн: один выгруженный экстракт → нормализация → компактный пакет с bbox, версией и датой",
      "Пакеты в релизе/репозитории; приложение не зависит от сети в момент занятия",
      "Видимая атрибуция «© OpenStreetMap contributors» + NOTICE с условиями ODbL",
    ],
    artifact: "tools/build-map-pack.mjs · data/maps/<city>.v1.json · NOTICE",
    done: "Маршрут открывается офлайн; источник и дата выгрузки видны в интерфейсе",
  },
  {
    id: "perf",
    title: "Пространственный индекс, LOD и FPS-бюджет",
    tier: "P1",
    category: "Производительность",
    impact: 7,
    effort: 5,
    duration: "4–6 дней",
    problem:
      "До 800 зданий, carHits перебирает все blocks, центральное и боковые зеркала дают дополнительные проходы рендера, тени 2048. Бюджет кадра не контролируется автоматически.",
    actions: [
      "Сетка 10 м для проверки столкновений, только соседние ячейки",
      "Чанки и LOD вокруг машины, instancing однотипных объектов, переключатель качества",
      "Автоматический perf-smoke на синтетической сцене в CI (без проверки на школьном ПК)",
    ],
    artifact: "src/world/spatialGrid.ts · docs/perf-budget.md",
    done: "p95 < 33 мс в CI perf-smoke при районе 400 × 400 м",
  },
  {
    id: "legal",
    title: "Лицензия, атрибуция и корректные формулировки",
    tier: "P1",
    category: "Юридическое",
    impact: 7,
    effort: 2,
    duration: "1 день",
    problem:
      "В DEV_PROMPTS указано «Лицензия пока не выбрана». ODbL разрешает коммерческое использование, но требует атрибуции и share-alike для распространяемой производной базы. Формулировки про «экзамен в ГАИ» создают лишний риск.",
    actions: [
      "Выбрать лицензию продукта и отдельно — ядра/данных; добавить LICENSE",
      "✓ NOTICE с атрибуцией ODbL, дисклеймером и политикой данных — есть в интерфейсе и как файл",
      "LICENSE для кода и условия распространения выбирает владелец — решения пока нет",
      "Терминология: ГИБДД, подготовка к экзамену; не обещать официальный зачёт",
    ],
    artifact: "LICENSE · NOTICE · docs/legal-checklist.md",
    done: "Школа и юрист видят понятные условия и источники данных",
  },
  {
    id: "scenarios",
    title: "Сценарии и маршруты как данные",
    tier: "P2",
    category: "Продукт",
    impact: 8,
    effort: 7,
    duration: "1–2 недели",
    problem:
      "Площадка зашита константами BAY / AISLE / START, город смещён на z = −160. Новое упражнение или маршрут = правка кода и новый релиз.",
    actions: [
      "JSON-схема сценария: геометрия, старт, контрольные точки, лимиты, активный набор правил",
      "Валидация схемы и редактор для инструктора",
      "Каталог сценариев с версиями и возможностью отката",
    ],
    artifact: "src/scenarios/schema.ts · data/scenarios/*.json",
    done: "Новое упражнение добавляется файлом данных без релиза приложения",
  },
  {
    id: "instructor",
    title: "Кабинет инструктора и разбор ошибок",
    tier: "P2",
    category: "Продукт",
    impact: 8,
    effort: 6,
    duration: "1–2 недели",
    problem:
      "Есть только мгновенная строка status и итоговый балл. Журнал попыток, разбор ошибок и статистика значатся в roadmap, но не реализованы.",
    actions: [
      "Журнал попыток: localStorage → IndexedDB → при необходимости сервер",
      "Экран разбора: таймлайн событий, карточка нарушения, повтор заезда",
      "Экспорт отчёта для автошколы, минимизация персональных данных",
    ],
    artifact: "src/analytics/* · src/ui/Debrief.tsx",
    done: "Инструктор за минуту объясняет ученику, что, где и по какому правилу нарушено",
  },
  {
    id: "input",
    title: "USB-руль и педали через адаптеры ввода",
    tier: "P2",
    category: "Оборудование",
    impact: 5,
    effort: 6,
    duration: "1–2 недели",
    problem:
      "Клавиатура и тач не передают плавность усилия и реальные углы; инвариант «газ/тормоз только клавиатура» придётся пересматривать при подключении железа.",
    actions: [
      "Адаптеры Keyboard / Gamepad API / HID / Touch → единый InputState",
      "Калибровка осей, мёртвых зон и профили устройств",
      "Клавиатура остаётся fallback для любого ПК",
    ],
    artifact: "src/input/adapters/*",
    done: "Новое устройство подключается без правок ядра и правил оценки",
  },
];

export type Drift = {
  topic: string;
  readme: string;
  doc: string;
  code: string;
  verdict: string;
};

export const drifts: Drift[] = [
  {
    topic: "Структура проекта",
    readme: "src/input, src/vehicle, src/world, src/scenarios, src/scoring, src/ui, src-tauri",
    doc: "«Один HTML-файл, весь код в одном <script>», однофайловость — инвариант №9",
    code: "3 файла в корне: README.md, DEV_PROMPTS.md, DrivingSim_Merged_v8_ackermann.html",
    verdict: "README описывает будущее как настоящее. Нужны две вкладки: «план» и «факт».",
  },
  {
    topic: "Имя рабочего файла",
    readme: "не указано",
    doc: "Опорный файл: DrivingSim_OSM_layers_v8.html, ~1050 строк",
    code: "DrivingSim_Merged_v8_ackermann.html, ~1540 строк, 131 КБ",
    verdict: "Документ-памятка уже ссылается на несуществующий файл: источник истины потерян.",
  },
  {
    topic: "Модель автомобиля",
    readme: "Кинематическая модель «велосипед»",
    doc: "«Велосипед» + геометрия Аккермана, ±540° руля, Kia Ceed",
    code: "ackermannAngle(), SW.ratio, отдельные углы внутреннего/внешнего колеса",
    verdict: "Код богаче документации. Аккерман — сильная сторона, её стоит описать и покрыть тестами.",
  },
  {
    topic: "Устройства ввода",
    readme: "«Сейчас: клавиатура», руль/педали и тач позже",
    doc: "Тач-педали, экранный SVG-руль, ЛКМ-руль, ПКМ-камера",
    code: "initTouchControls(), createMirrorControls(), обработчики pointer",
    verdict: "Тач и экранный руль уже сделаны, но не отражены в README; USB всё ещё впереди.",
  },
  {
    topic: "Оценка результата",
    readme: "«Набор критериев, сверяется с инструкторами»",
    doc: "«Балл по числу касаний»: 100 − 15 за касание",
    code: "score = Math.max(0, 100 - 15 * collisions) после 1,5 с остановки",
    verdict: "Главное расхождение: вместо экзаменационной модели — аркадный счётчик.",
  },
  {
    topic: "Источник карты",
    readme: "OpenStreetMap через Overpass API",
    doc: "Загрузка OSM JSON из файла или по https-URL, GeoJSON не поддерживается",
    code: "loadOsm(data, append), fetch по URL с таймаутом и лимитом 30 МБ",
    verdict: "Overpass используется человеком вне приложения, а не приложением. Так и нужно зафиксировать.",
  },
  {
    topic: "Работа без интернета",
    readme: "Проверка на школьном ПК: запуск, FPS, работа без интернета",
    doc: "Риск: «CDN. Игра требует интернет (Three.js с cdnjs)»",
    code: "<script src='https://cdnjs.cloudflare.com/.../three.min.js'>",
    verdict: "Прямое противоречие требованию MVP. Чинится переносом в npm-сборку. Проверка на школьном ПК исключена из плана: вместо неё offline-smoke и автотесты в CI.",
  },
  {
    topic: "Состав упражнений",
    readme: "Этап 1: заезд в бокс задним ходом; 2,5 × 5,5 м",
    doc: "Два ряда по 4 бокса 2,5 × 5,3 м, проезд 6 м, «предварительно»",
    code: "BAY, AISLE, COLS; 4 занятых места; успех = полное вхождение + 1,5 с",
    verdict: "Размеры не подтверждены источником, а между документами отличаются на 20 см.",
  },
];

export const layersNow = [
  { id: "n1", name: "Единый HTML + <script>", sub: "~1540 строк · ~60 глобальных функций", detail: "UI, HUD, зеркала, ввод, физика, столкновения, OSM-парсер и подсчёт баллов находятся в одной области видимости. Нет границ, которые можно протестировать по отдельности." },
  { id: "n2", name: "DOM / HUD / зеркала", sub: "панели, canvas, z-index 10002+", detail: "Богатый интерфейс уже реализован: три зеркала, тач-педали, тахометр, draggable-окна. Это ценный актив, но он тесно связан с состоянием симуляции." },
  { id: "n3", name: "THREE.js r128 с CDN", sub: "внешняя зависимость в рантайме", detail: "Без интернета сцена не стартует, версия библиотеки не зафиксирована в package.json, обновления непредсказуемы." },
  { id: "n4", name: "OSM JSON из файла / URL", sub: "дороги, здания ≤800, светофоры", detail: "Данные подгружаются вручную в момент занятия. Нет версии выгрузки, bbox, нормализации и офлайн-пакета." },
  { id: "n5", name: "Проверка: node --check + чеклист", sub: "«не проверено в браузере»", detail: "Ручной чеклист из 16 пунктов — единственный барьер перед релизом. Модель не может сама подтвердить, что правка ничего не сломала." },
];

export const layersTarget = [
  { id: "t1", name: "Адаптеры ввода", sub: "Keyboard · Touch · Gamepad/HID", detail: "Каждый адаптер отдаёт один и тот же InputState. Ядро не знает, откуда пришло управление, поэтому железо подключается без переписывания физики." },
  { id: "t2", name: "Чистое ядро (core)", sub: "step(state, input, dt=1/60)", detail: "Детерминированный модуль без THREE и DOM: кинематика Аккермана, габариты, столкновения, события. Запускается в Node, покрыт unit-тестами." },
  { id: "t3", name: "Данные сценариев и карт", sub: "scenario.json · map-pack v1", detail: "Геометрия площадки, маршруты, контрольные точки и OSM-пакеты — версионированные файлы с источником и датой, а не константы в коде." },
  { id: "t4", name: "Движок правил", sub: "evaluate(events, rules)", detail: "Версионированный набор правил с формулировками для ученика, порогом verdict и подписью инструктора. Результат попытки всегда знает rulesVersion." },
  { id: "t5", name: "Рендер Three.js", sub: "сцена · камеры · зеркала · LOD", detail: "Только отображение состояния ядра. Интерполяция между шагами, чанки вокруг машины, instancing, профили качества под слабый ПК." },
  { id: "t6", name: "UI и кабинет инструктора", sub: "React + Tailwind · HUD · дебрифинг", detail: "Тот же стек, что у этого дашборда. Разбор ошибок, журнал попыток, реплей, экспорт отчёта. UI не содержит бизнес-логики оценки." },
  { id: "t7", name: "Сквозные механизмы", sub: "replay · telemetry · CI-гейты", detail: "Запись ввода, эталонные заезды, FPS-бюджет и автоматические проверки работают поверх всех слоёв и делают правки модели безопасными." },
];

export type Phase = {
  id: string;
  num: string;
  title: string;
  period: string;
  goal: string;
  tasks: string[];
  dod: string[];
  metric: string;
};

export const phases: Phase[] = [
  {
    id: "ph0",
    num: "0",
    title: "Стабилизация",
    period: "1 неделя",
    goal: "Сделать текущий прототип запускаемым, проверяемым и честно описанным. Никаких новых фич.",
    tasks: [
      "Three.js из npm, Vite-сборка, запуск без интернета",
      "Разбить `<script>` на ES-модули без изменения логики",
      "Vitest на invariants, insideBay, carHits и текущую формулу балла",
      "CI: node --check → tsc → test → Playwright smoke",
      "Свести README, DEV_PROMPTS и код к одному описанию; завести ADR",
    ],
    dod: [
      "Офлайн-запуск подтверждён автоматическим smoke-тестом бандла в CI (без ручной проверки ПК)",
      "npm test проходит, нет внешних URL в бандле",
      "В README отдельно помечены «реализовано» и «план»",
    ],
    metric: "Зелёный CI + офлайн-запуск + 0 расхождений в документах",
  },
  {
    id: "ph1",
    num: "1",
    title: "Доверие к оценке",
    period: "2–3 недели",
    goal: "Превратить аркадный счётчик в объяснимую и проверяемую модель вердикта.",
    tasks: [
      "Ядро с фиксированным шагом и единым InputState",
      "rules.json + evaluate(): баллы, немедленный провал, текст нарушения",
      "Калибровка: инструмент сверки готов (слепой режим, доля совпадений); сами заезды и вердикты 2–3 инструкторов ещё впереди",
      "Запись и реплей попытки; разбор ошибок на экране",
      "Disclaimer «учебная симуляция», версия правил в отчёте",
    ],
    dod: [
      "Каждое событие имеет код правила и человекочитаемое объяснение",
      "Спорный заезд воспроизводится из JSON попытки",
      "Все неподтверждённые значения помечены в UI как «предварительные»",
    ],
    metric: "≥90% совпадения с вердиктами инструкторов на эталонной выборке",
  },
  {
    id: "ph2",
    num: "2",
    title: "Город и маршруты",
    period: "4–6 недель",
    goal: "Перейти от статичной площадки к реальной местности без зависимости от сети и просадок FPS.",
    tasks: [
      "Build-time OSM → нормализованный map pack с bbox и датой",
      "Схема сценария: старт, контрольные точки, тайминги, активные правила",
      "Сетка столкновений, чанки/LOD, instancing и профили качества",
      "Светофор и знак как состояние мира, а не просто препятствие",
      "Первые события маршрута: стоп-линия, сигнал поворота, уступление пешеходу",
    ],
    dod: [
      "Маршрут 400 × 400 м работает офлайн",
      "Автоматический perf-smoke в CI укладывается в бюджет кадра; профили качества для слабого GPU",
      "Атрибуция ODbL видна в интерфейсе",
    ],
    metric: "Воспроизводимый проезд маршрута и зелёный CI без ручной проверки ПК",
  },
  {
    id: "ph3",
    num: "3",
    title: "Продукт для автошколы",
    period: "4–6 недель",
    goal: "Дать инструктору инструмент, а не демо: редактор, журнал, отчёты, упаковка.",
    tasks: [
      "Редактор боксов и маршрутов с валидацией схемы",
      "✓ Журнал попыток в IndexedDB (до 300), статистика по ученику, экспорт CSV/JSON",
      "Адаптер руля и педалей: код и калибровка по шагам готовы, на реальном устройстве не проверялся",
      "Tauri-сборка с локальными ассетами и автообновлением",
      "Пилот в 1–2 автошколах и сбор обратной связи",
    ],
    dod: [
      "Инструктор добавляет упражнение без разработчика",
      "Установка на Windows без интернета",
      "LICENSE, NOTICE и политика данных зафиксированы",
    ],
    metric: "Пилот в двух школах + повторные занятия на тренажёре",
  },
];

export type Risk = {
  title: string;
  level: "Высокий" | "Средний";
  area: string;
  effect: string;
  mitigation: string;
};

export const risks: Risk[] = [
  { title: "Невалидная модель оценки", level: "Высокий", area: "Продукт", effect: "Школа учит по шкале, которая не совпадает с экзаменационным листом; доверие теряется сразу.", mitigation: "Калибровка с инструкторами, версия регламента в данных, статус «учебная симуляция»." },
  { title: "Ручная проверка больших ИИ-правок", level: "Высокий", area: "Процесс", effect: "Монолит + 69 КБ памятки + node --check: регрессия в HUD или физике обнаруживается только вручную.", mitigation: "Малые PR, контракты, автотесты и Playwright до merge; модель не меняет scoring без человека." },
  { title: "Зависимость от CDN", level: "Высокий", area: "Инфраструктура", effect: "Тренажёр не запускается в классе без интернета, хотя это условие MVP.", mitigation: "npm + локальный бандл, offline-smoke в CI." },
  { title: "Overpass в рантайме", level: "Высокий", area: "Данные", effect: "Публичный сервер имеет лимиты и не предназначен для коммерческого приложения; занятие срывается.", mitigation: "Build-time экстракт, версионированные map pack'и, свой инстанс только для генерации." },
  { title: "ODbL и отсутствие лицензии", level: "Средний", area: "Юридическое", effect: "Нет атрибуции и ясных условий распространения производной базы данных.", mitigation: "NOTICE, «© OpenStreetMap contributors», LICENSE, разграничение produced work / derivative database." },
  { title: "Производительность рендера", level: "Средний", area: "Perf", effect: "800 зданий, 3 прохода рендера и полный перебор blocks дают просадки кадра.", mitigation: "Spatial grid, LOD/чанки, автоматический perf-smoke в CI и профили качества." },
  { title: "Расхождение документации", level: "Средний", area: "Процесс", effect: "README, DEV_PROMPTS и HTML описывают разные проекты: модели работают по устаревшему контексту.", mitigation: "ADR рядом с кодом, автогенерация «что реализовано» из тестов, один источник истины." },
  { title: "Формулировка «экзамен в ГАИ»", level: "Средний", area: "Маркетинг", effect: "Ожидание официального зачёта и претензии от школы или проверяющих.", mitigation: "«Подготовка к практическому экзамену ГИБДД», явный disclaimer в UI и на сайте." },
];

export type ExamError = {
  id: string;
  label: string;
  points: number;
  note: string;
};

export const examErrors: ExamError[] = [
  { id: "e5a", label: "Сбил конус / пересёк линию разметки площадки", points: 5, note: "Критическая ошибка: экзамен прекращается" },
  { id: "e5b", label: "Пересёк стоп-линию при запрещающем сигнале", points: 5, note: "Критическая ошибка: экзамен прекращается" },
  { id: "e5c", label: "Не уступил дорогу пешеходу", points: 5, note: "Критическая ошибка: экзамен прекращается" },
  { id: "e5d", label: "Вмешательство инструктора в управление", points: 5, note: "Критическая ошибка: экзамен прекращается" },
  { id: "e3a", label: "Не включил нейтральную передачу после остановки", points: 3, note: "Значительная ошибка" },
  { id: "e3b", label: "Не выполнил задание экзаменатора", points: 3, note: "Значительная ошибка" },
  { id: "e2a", label: "Нарушение правил остановки", points: 2, note: "Средняя ошибка" },
  { id: "e2b", label: "Не приступил к заданию в установленное время", points: 2, note: "Средняя ошибка" },
  { id: "e1a", label: "Не подал сигнал поворота", points: 1, note: "Незначительная ошибка" },
  { id: "e1b", label: "Резкое торможение без необходимости", points: 1, note: "Незначительная ошибка" },
];

export type Snippet = {
  id: string;
  label: string;
  file: string;
  code: string;
};

export const snippets: Snippet[] = [
  {
    id: "types",
    label: "Контракт ввода",
    file: "src/core/types.ts",
    code: `// Единственный контракт между устройством и симуляцией
export type InputState = {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steering: number;   // -1..1
  gear: 'R' | 'N' | 'D' | '1' | '2' | '3';
  signals: { left: boolean; right: boolean };
  engineOn: boolean; handbrake: boolean; belt: boolean;
};

export type SimState = {
  x: number; z: number; heading: number;   // вперёд +Z, лево +X
  v: number; steer: number; wheelDeg: number;
};

// Чистая функция: никаких THREE, DOM и rAF
export function step(s: SimState, i: InputState, dt = 1 / 60): SimState { /* ... */ }`,
  },
  {
    id: "loop",
    label: "Фиксированный шаг",
    file: "src/core/loop.ts",
    code: `const STEP = 1 / 60;
let acc = 0;

export function frame(nowMs: number) {
  const delta = Math.min((nowMs - last) / 1000, 0.1);
  last = nowMs;
  acc += delta;

  // Ядро всегда считается одинаковыми шагами -> воспроизводимость
  while (acc >= STEP) {
    const input = inputAdapter.read();
    state = step(state, input, STEP);
    recorder.append(tick++, input, state); // реплей = тест
    acc -= STEP;
  }

  render(state, acc / STEP); // интерполяция только для картинки
  requestAnimationFrame(frame);
}`,
  },
  {
    id: "rules",
    label: "Правила как данные",
    file: "src/scoring/rules/ru.demo.json",
    code: `{
  "version": "demo-0.1",
  "status": "unvalidated",
  "source": "Сверить с приложением №4 действующего регламента + инструктор",
  "effectiveFrom": "2026-01-01",
  "failThreshold": 5,
  "rules": [
    { "id": "line_cross", "points": 5, "kind": "immediate",
      "message": "Пересечение линии разметки площадки" },
    { "id": "neutral_after_stop", "points": 3, "kind": "penalty",
      "message": "Не включена нейтральная передача после остановки" },
    { "id": "no_turn_signal", "points": 1, "kind": "penalty",
      "message": "Не подан сигнал поворота" }
  ]
}`,
  },
  {
    id: "test",
    label: "Тест как гейт для модели",
    file: "tests/scoring.test.ts",
    code: `import { evaluate } from '../src/scoring/evaluate';
import rules from '../src/scoring/rules/ru.demo.json';

it('одно касание линии = немедленный провал', () => {
  const r = evaluate([{ type: 'line_cross', t: 12.4 }], rules);
  expect(r.verdict).toBe('НЕ СДАЛ');
  expect(r.points).toBe(5);
  expect(r.explanation[0].ruleId).toBe('line_cross');
});

it('попытка хранит версию правил', () => {
  expect(r.rulesVersion).toBe('demo-0.1');
});`,
  },
];

export const checklist = [
  { id: "c1", text: "Перенести Three.js с cdnjs в npm и собрать Vite", hint: "Блокирует офлайн-запуск" },
  { id: "c2", text: "Добавить offline-smoke: в dist нет внешних URL", hint: "Автоматически в CI, без ручной проверки ПК" },
  { id: "c3", text: "Вынести `<script>` в ES-модули без изменения логики", hint: "Только механический перенос" },
  { id: "c4", text: "Добавить Vitest на carHits, insideBay и текущий балл", hint: "Зафиксировать поведение как есть" },
  { id: "c5", text: "Свести README / DEV_PROMPTS / код и завести первый ADR", hint: "Удалить ссылку на несуществующий v8-файл" },
  { id: "c6", text: "Описать rules.json с полями source и effectiveFrom", hint: "Пока без активации в проде" },
  { id: "c7", text: "Отправить инструктору 5 вопросов: бокс, проезд, ошибки, регламент, «У»", hint: "Один документ, один созвон" },
  { id: "c8", text: "Настроить CI: node --check → tsc → test → Playwright", hint: "Модель проходит тот же конвейер" },
];

export const sources = [
  { label: "Репозиторий CityDrivingTraining", url: "https://github.com/FroloveD/CytyDrivingTraining" },
  { label: "DEV_PROMPTS.md — памятка для модели", url: "https://github.com/FroloveD/CytyDrivingTraining/blob/main/DEV_PROMPTS.md" },
  { label: "DrivingSim_Merged_v8_ackermann.html", url: "https://github.com/FroloveD/CytyDrivingTraining/blob/main/DrivingSim_Merged_v8_ackermann.html" },
  { label: "OSM Wiki: Overpass API и лимиты", url: "https://wiki.openstreetmap.org/wiki/Overpass_API" },
  { label: "Экзаменационный лист (приложение №4)", url: "https://base.garant.ru/400484177/323c81eda0eaeeb0c158c525a3268a36/" },
  { label: "МВД: изменения оценки практического экзамена", url: "https://mvdmedia.ru/news/official/mvd-rossii-vneseny-izmeneniya-v-vedomstvennyy-prikaz-reglamentiruyushchiy-poryadok-provedeniya-ekzam/" },
];

export const planMarkdown = `# CityDrivingTraining — план на 7 дней
1. Three.js -> npm/Vite, офлайн-запуск без CDN.
2. Вынести <script> в ES-модули без смены логики.
3. Vitest: инварианты координат, carHits, insideBay, формула балла.
4. CI: node --check -> tsc -> test -> Playwright smoke.
5. Свести README, DEV_PROMPTS и реальный HTML; завести ADR.
6. rules.json (source, effectiveFrom, failThreshold) как данные, пока demo.
7. Вопросы инструктору: размеры бокса, проезд, перечень ошибок, версия регламента, табличка «У».

Принцип: модель генерирует код и тесты, источник истины — код + тесты + подпись инструктора.

По решению проекта: проверку на школьном ПК не добавляем. Офлайн и производительность
контролируются автоматическими smoke-тестами и golden-набором в CI; калибровку критериев
подтверждает инструктор.
Старт симуляции всегда холодный: ДВС заглушен, КПП в P (Parking).
`;
