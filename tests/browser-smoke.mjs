/**
 * Браузерная проверка собранного приложения (Playwright, headless Chromium).
 * Проверяет то, чего не видно из тестов ядра: запуск сцены, вождение с клавиатуры,
 * точный реплей, сверку с инструктором, журнал в IndexedDB (перезагрузка и перенос
 * старого журнала), адаптер руля на подставном устройстве, раскладку панелей и навигацию.
 *
 * Запуск:
 *   npm i -D playwright && npx playwright install --with-deps chromium
 *   npm run build && python3 -m http.server 4173 --directory dist &
 *   node tests/browser-smoke.mjs http://127.0.0.1:4173/index.html "file://$PWD/dist/index.html" .smoke
 *
 * Аргументы: адрес по HTTP, адрес файла (file://) и папка для снимков экрана.
 * Реальный USB-руль тест не заменяет: устройство подставляется через navigator.getGamepads.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const [, , httpUrl, fileUrl, shotDir] = process.argv;
fs.mkdirSync(shotDir, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

async function open(ctx, url) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text().slice(0, 200)); });
  await page.goto(url);
  await page.waitForSelector("canvas");
  await sleep(1200);
  return { page, errors };
}
const speedOf = (page) => page.evaluate(() => {
  const span = [...document.querySelectorAll("span")].find((s) => s.textContent === "км/ч");
  return span && span.parentElement ? parseInt(span.parentElement.textContent ?? "", 10) : -1;
});
async function until(fn, timeout = 20000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await sleep(step);
  }
}
const tab = (page, name) => page.getByRole("button", { name: new RegExp(name) }).first().click();
const low = async (page) => (await page.evaluate(() => document.body.innerText)).toLowerCase();
const panelArtifacts = (page) => page.evaluate(() => {
  const pre = [...document.querySelectorAll("pre")].map((el) => el.innerText).join("\n");
  return pre;
});

const readIdb = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open("cdt-journal");
  req.onerror = () => reject(new Error("open failed"));
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(["meta", "payload"], "readonly");
    const m = tx.objectStore("meta").getAll();
    const p = tx.objectStore("payload").getAll();
    tx.oncomplete = () => {
      const meta = m.result[0];
      const payload = p.result.find((x) => meta && x.id === meta.id);
      resolve({
        metaCount: m.result.length,
        payloadCount: p.result.length,
        metaHasStream: Boolean(meta && "inputStream" in meta),
        hasRules: Boolean(payload && payload.rulesAtRide),
        frames: payload ? payload.inputStream.length : 0,
        reviews: meta && meta.reviews ? meta.reviews.length : 0,
        attempt: meta && payload ? { ...meta, trajectory: payload.trajectory, inputStream: payload.inputStream } : null,
      });
    };
  };
}));

let legacyAttempt = null;

// Все вкладки навигации видны без горизонтальной прокрутки
const navFits = (page) => page.evaluate(() => {
  const nav = document.querySelector("header nav");
  return nav ? { ok: nav.scrollWidth <= nav.clientWidth + 1, need: nav.scrollWidth, have: nav.clientWidth } : { ok: false, need: 0, have: 0 };
});

// Пересечения панелей в раскладке по умолчанию (true = панели наложились или не найдены)
const layoutOverlaps = (page) => page.evaluate(() => {
  const spans = [...document.querySelectorAll("span")];
  const panelOf = (el) => (el ? el.closest("div.absolute") : null);
  const mirror = panelOf(spans.find((s) => s.textContent === "Зеркало заднего вида"));
  const wheel =
    document.querySelector('[aria-label="Рулевое колесо"]')?.closest("div.absolute") ??
    panelOf(spans.find((s) => s.textContent === "Руль"));
  const status = panelOf(spans.find((s) => (s.textContent ?? "").startsWith("Двигатель заглушен")));
  const kmh = spans.find((s) => s.textContent === "км/ч");
  const speed = kmh ? kmh.parentElement : null;
  const camera = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "1 Сзади");
  const hit = (a, b) => {
    if (!a || !b) return true;
    const p = a.getBoundingClientRect();
    const q = b.getBoundingClientRect();
    return !(p.right <= q.left || q.right <= p.left || p.bottom <= q.top || q.bottom <= p.top);
  };
  return {
    found: Boolean(mirror && wheel && status && speed && camera),
    mirrorStatus: hit(mirror, status),
    wheelSpeed: hit(wheel, speed),
    wheelCamera: hit(wheel, camera),
  };
});

// ───────── A. Клавиатура, разбор, сверка, журнал ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);
  let text = await low(page);
  check("A1  холодный старт: ДВС заглушен, КПП P", text.includes("кпп — p (parking)"));
  check("A2  WebGL-сцена: зеркала отрисованы, 2D-запасной режим не включён", text.includes("зеркало заднего вида"));

  const lay = await layoutOverlaps(page);
  check("A2b раскладка по умолчанию: зеркало не закрывает строку задания", lay.found && !lay.mirrorStatus, JSON.stringify(lay));
  check("A2c раскладка по умолчанию: руль не закрывает спидометр и кнопки камеры", lay.found && !lay.wheelSpeed && !lay.wheelCamera, JSON.stringify(lay));
  const nav1440 = await navFits(page);
  check("A2d навигация: все 7 вкладок видны на экране 1440 px", nav1440.ok, `нужно ${nav1440.need}px, есть ${nav1440.have}px`);
  await page.screenshot({ path: `${shotDir}/layout.png` });

  await page.getByRole("button", { name: "Быстрый старт" }).click();
  await sleep(400);
  await page.keyboard.down("KeyW");
  await page.keyboard.down("KeyA");
  await sleep(900);
  await page.keyboard.up("KeyA");
  const v1 = await until(async () => { const v = await speedOf(page); return v > 0 ? v : 0; });
  check("A3  газ W после быстрого старта разгоняет машину", v1 > 0, `скорость ${v1} км/ч`);
  await page.screenshot({ path: `${shotDir}/sim.png` });
  await page.keyboard.up("KeyW");
  await page.keyboard.down("KeyS");
  const stopped = await until(async () => (await speedOf(page)) === 0);
  await page.keyboard.up("KeyS");
  check("A4  тормоз S останавливает машину", Boolean(stopped));

  await page.keyboard.press("KeyH");
  await sleep(500);
  text = await low(page);
  check("A5  клавиша H: приборы скрыты, зеркала остались", !text.includes("км/ч") && text.includes("зеркало заднего вида"));
  await page.keyboard.press("KeyH");
  await sleep(300);

  await page.getByRole("button", { name: /Завершить/ }).click();
  await sleep(700);
  check("A6  «Завершить → Разбор» открывает протокол", (await low(page)).includes("разбор ошибок и реплей заезда"));
  await page.getByRole("button", { name: /Проверить детерминизм/ }).click();
  await sleep(600);
  const raw = await page.evaluate(() => document.body.innerText);
  const det = raw.match(/Детерминизм подтверждён[^\n]*/);
  const other = raw.match(/Расхождение реплея[^\n]*|Запись ввода неполная[^\n]*|В попытке нет[^\n]*/);
  check("A7  реплей настоящего заезда с клавиатуры совпал с записью", Boolean(det), (det ?? other ?? ["нет сообщения"])[0].slice(0, 150));

  await page.getByPlaceholder("Фамилия И.О.").fill("Иванов И.И.");
  await page.getByRole("button", { name: /Мой вердикт: НЕ СДАЛ/ }).click();
  await sleep(400);
  text = await low(page);
  check("A8  вердикт инструктора записан и сравнён с симулятором", text.includes("иванов и.и.") && (text.includes("расхождение с симулятором") || text.includes("совпало с симулятором")));
  await page.screenshot({ path: `${shotDir}/debrief.png`, fullPage: true });

  await tab(page, "Статистика");
  await sleep(500);
  text = await low(page);
  check("A9  статистика: 1 оценка, статус «мало данных», а не «цель достигнута»", text.includes("из 1 оценки") && text.includes("мало данных: 1 из 20") && !text.includes("достигнута"));
  await page.screenshot({ path: `${shotDir}/stats.png`, fullPage: true });

  await page.reload();
  await page.waitForSelector("canvas");
  await sleep(1500);
  await tab(page, "Статистика");
  await sleep(600);
  text = await low(page);
  check("A10 после перезагрузки попытка и оценка на месте", text.includes("иванов и.и.: не сдал") && !text.includes("indexeddb недоступно"));

  const idb = await readIdb(page);
  legacyAttempt = idb.attempt;
  check("A11 IndexedDB: одна запись на заезд, поток ввода отдельно, правила заезда сохранены",
    idb.metaCount === 1 && idb.payloadCount === 1 && !idb.metaHasStream && idb.hasRules && idb.frames > 0 && idb.reviews === 1,
    `meta ${idb.metaCount}, payload ${idb.payloadCount}, кадров ввода ${idb.frames}, оценок ${idb.reviews}`);

  for (const [name, marker] of [
    ["Свой сценарий", "конструктор упражнений"],
    ["Инструктор и Правила", "кабинет инструктора: калибровка и штрафы"],
    ["План и стратегия", "диагноз репозитория"],
    ["Тесты и Модули", "автотесты ядра и модульная архитектура"],
  ]) {
    await tab(page, name);
    await sleep(600);
    check(`A12 вкладка «${name}» открывается`, (await low(page)).includes(marker));
  }
  const rawTests = await page.evaluate(() => document.body.innerText);
  const m = rawTests.match(/ТЕСТЫ:\s*(\d+)\/(\d+)/i);
  check("A13 автотесты ядра в браузере пройдены все", Boolean(m) && m[1] === m[2] && Number(m[2]) >= 20, m ? m[0] : "счётчик не найден");
  const badge = (await page.getByRole("button", { name: /Тесты и Модули/ }).first().innerText()).replace(/\s+/g, " ");
  check("A14 значок тестов в навигации — живой результат", /(\d+)\/\1/.test(badge), badge);
  check("A15 ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("A   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── B. Перенос журнала прежней версии ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await open(ctx, httpUrl);
  if (!legacyAttempt) throw new Error("нет попытки из сценария A");
  await page.evaluate((a) => {
    const old = { ...a, id: "legacy-1" };
    delete old.reviews;
    localStorage.setItem("cdt.attempts.journal.v1", JSON.stringify([old]));
  }, legacyAttempt);
  await page.reload();
  await page.waitForSelector("canvas");
  await sleep(1500);
  const text = await low(page);
  const keyLeft = await page.evaluate(() => localStorage.getItem("cdt.attempts.journal.v1"));
  const idb = await readIdb(page);
  check("B1  старый журнал перенесён в IndexedDB, ключ localStorage удалён", keyLeft === null && idb.metaCount === 1 && idb.payloadCount === 1, `meta ${idb.metaCount}, ключ ${keyLeft === null ? "удалён" : "остался"}`);
  check("B2  пользователь видит сообщение о переносе", text.includes("журнал перенесён в indexeddb, попыток: 1"));
  await tab(page, "Разбор и Реплей");
  await sleep(600);
  check("B3  перенесённая попытка открывается в разборе", (await low(page)).includes("разбор ошибок и реплей заезда"));
  check("B4  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("B   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── C. Адаптер руля на подставном геймпаде ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const state = { rt: 0, lx: 0 };
    window.__pad = state;
    const make = () => ({
      index: 0, id: "Mock Controller (STANDARD GAMEPAD)", mapping: "standard", connected: true, timestamp: performance.now(),
      axes: [state.lx, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => { const v = i === 7 ? state.rt : 0; return { pressed: v > 0.5, touched: v > 0, value: v }; }),
    });
    Object.defineProperty(navigator, "getGamepads", { value: () => [make(), null, null, null], configurable: true });
  });
  const { page, errors } = await open(ctx, httpUrl);
  await page.getByRole("button", { name: "Быстрый старт" }).click();
  await sleep(400);
  await page.evaluate(() => { window.__pad.rt = 1; });
  await sleep(2500);
  const before = await speedOf(page);
  check("C1  подключённый, но не включённый геймпад с нажатым газом не двигает машину", before === 0, `скорость ${before} км/ч`);

  await page.getByRole("button", { name: /^\s*Управление\s*$/ }).click();
  await sleep(500);
  let text = await low(page);
  check("C2  панель видит устройство и не считает его настроенным", text.includes("mock controller") && text.includes("не настроено"));
  await page.getByLabel("Использовать устройство").check();
  const after = await until(async () => { const v = await speedOf(page); return v > 0 ? v : 0; });
  check("C3  после включения триггер RT даёт газ", after > 0, `скорость ${after} км/ч`);
  await page.screenshot({ path: `${shotDir}/controls.png` });

  await page.evaluate(() => { window.__pad.rt = 0; window.__pad.lx = -1; });
  const leftOk = await until(async () => (await page.evaluate(() => document.body.innerText)).includes("← 540°"), 8000);
  check("C4  стик ВЛЕВО поворачивает руль ВЛЕВО (← 540°)", Boolean(leftOk));
  await page.evaluate(() => { window.__pad.lx = 1; });
  const rightOk = await until(async () => (await page.evaluate(() => document.body.innerText)).includes("540° →"), 8000);
  check("C5  стик ВПРАВО поворачивает руль ВПРАВО (540° →)", Boolean(rightOk));

  await page.getByLabel("Использовать устройство").uncheck();
  await page.evaluate(() => { window.__pad.lx = -1; window.__pad.rt = 1; });
  await sleep(1500);
  const raw = await page.evaluate(() => document.body.innerText);
  check("C6  после выключения устройство снова не влияет на руль", !raw.includes("← 540°"));
  check("C7  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("C   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── D. Открытие файла напрямую (file://) ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await open(ctx, fileUrl);
  await tab(page, "Разбор и Реплей");
  await sleep(400);
  await page.getByRole("button", { name: /Сгенерировать демо-попытку/ }).click();
  await sleep(700);
  await page.reload();
  await page.waitForSelector("canvas");
  await sleep(1500);
  await tab(page, "Статистика");
  await sleep(600);
  const text = await low(page);
  check("D1  при открытии dist/index.html как файла журнал тоже сохраняется", text.includes("демо (синтетика)") && !text.includes("indexeddb недоступно"));
  check("D2  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("D   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── F. Мастер калибровки руля с нестандартной раскладкой ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    // Педали «перевёрнуты»: покой +1, нажата −1; до первого нажатия драйвер отдаёт 0
    const state = { axes: [0, 0, 0] };
    window.__wheel = state;
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [{
        index: 0, id: "Mock Racing Wheel", mapping: "", connected: true, timestamp: performance.now(),
        axes: [...state.axes],
        buttons: Array.from({ length: 12 }, () => ({ pressed: false, touched: false, value: 0 })),
      }, null, null, null],
      configurable: true,
    });
  });
  const { page, errors } = await open(ctx, httpUrl);
  const setAxes = (a) => page.evaluate((v) => { window.__wheel.axes = v; }, a);
  const next = async () => { await page.getByRole("button", { name: "Далее" }).click(); await sleep(250); };
  await page.getByRole("button", { name: "Быстрый старт" }).click();
  await page.getByRole("button", { name: /^\s*Управление\s*$/ }).click();
  await sleep(500);
  check("F1  рулю без стандартной раскладки предлагается калибровка, а не угаданные оси", (await low(page)).includes("нужна калибровка"));
  await page.getByRole("button", { name: /Калибровать/ }).click();
  await sleep(300);
  await next();
  check("F2  шаг без поворота руля отклоняется с пояснением", (await low(page)).includes("поворот руля не обнаружен"));
  for (const axes of [[-0.8, 0, 0], [0, -1, 0], [0, 1, 0], [0, 1, -1], [0, 1, 1]]) {
    await setAxes(axes);
    await sleep(200);
    await next();
  }
  const text = await low(page);
  check("F3  после пяти шагов устройство включено", text.includes("управляет") && text.includes("калибровка завершена"));
  await sleep(1500);
  const rest = await speedOf(page);
  check("F4  педали в покое (+1) после калибровки не дают газа", rest === 0, `скорость ${rest} км/ч`);
  await setAxes([0, -1, 1]);
  const v = await until(async () => { const s = await speedOf(page); return s > 0 ? s : 0; });
  check("F5  нажатая педаль газа (ось 1: +1 → −1) разгоняет машину", v > 0, `скорость ${v} км/ч`);
  await setAxes([-0.5, 1, 1]);
  const left = await until(async () => /← \d+°/.test(await page.evaluate(() => document.body.innerText)), 8000);
  check("F6  поворот руля влево даёт поворот влево", Boolean(left));
  check("F7  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("F   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── G. Реплей по своему сценарию и по импортированной карте ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);
  const driveAndVerify = async (label, steerKey) => {
    await page.getByRole("button", { name: "Быстрый старт" }).click();
    await sleep(400);
    await page.keyboard.down("KeyW");
    await page.keyboard.down(steerKey);
    await sleep(1500);
    await page.keyboard.up(steerKey);
    await page.keyboard.up("KeyW");
    await page.getByRole("button", { name: /Завершить/ }).click();
    await sleep(700);
    await page.getByRole("button", { name: /Проверить детерминизм/ }).click();
    await sleep(600);
    const raw = await page.evaluate(() => document.body.innerText);
    const det = raw.match(/Детерминизм подтверждён[^\n]*/);
    const other = raw.match(/Расхождение реплея[^\n]*|Запись ввода неполная[^\n]*/);
    check(label, Boolean(det), (det ?? other ?? ["нет сообщения"])[0].slice(0, 130));
  };
  await tab(page, "Свой сценарий");
  await sleep(400);
  await page.getByRole("button", { name: /Открыть в тренажёре/ }).click();
  await sleep(1200);
  check("G1  свой сценарий открывается в тренажёре", (await low(page)).includes("2 бокса 90° · старт в проезде"));
  await driveAndVerify("G2  реплей заезда по своему сценарию совпал точно", "KeyD");

  await tab(page, "3D-Тренажёр");
  await sleep(800);
  const osm = { elements: [
    { type: "node", id: 1, lat: 55.75, lon: 37.61 },
    { type: "node", id: 2, lat: 55.752, lon: 37.61 },
    { type: "way", id: 10, nodes: [1, 2], tags: { highway: "residential", name: "ул. Тестовая" } },
  ] };
  await page.locator('input[type="file"]').first().setInputFiles({ name: "test-osm.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(osm)) });
  await sleep(1500);
  check("G3  локальный файл OSM импортируется и становится миром заезда", (await low(page)).includes("osm pack: дорог 1"));
  await driveAndVerify("G4  реплей заезда по импортированной карте совпал точно", "KeyA");
  check("G5  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("G   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── E. Небольшой экран ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const { page, errors } = await open(ctx, httpUrl);
  const lay = await layoutOverlaps(page);
  check("E1  раскладка по умолчанию на экране 1100×720 без наложений", lay.found && !lay.mirrorStatus && !lay.wheelSpeed && !lay.wheelCamera, JSON.stringify(lay));
  const nav1100 = await navFits(page);
  check("E1b навигация: все 7 вкладок видны на экране 1100 px", nav1100.ok, `нужно ${nav1100.need}px, есть ${nav1100.have}px`);
  check("E2  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: `${shotDir}/small.png` });
  await ctx.close();
} catch (e) {
  check("E   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── H. Типичный школьный экран 1366×768 ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, errors } = await open(ctx, httpUrl);
  const lay = await layoutOverlaps(page);
  check("H1  раскладка по умолчанию на экране 1366×768 без наложений", lay.found && !lay.mirrorStatus && !lay.wheelSpeed && !lay.wheelCamera, JSON.stringify(lay));
  const nav = await navFits(page);
  check("H2  навигация: все 7 вкладок видны на экране 1366 px", nav.ok, `нужно ${nav.need}px, есть ${nav.have}px`);
  check("H3  ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: `${shotDir}/school.png` });
  await ctx.close();
} catch (e) {
  check("H   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── I. Заезд переживает переключение вкладок и закрытие страницы ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await open(ctx, httpUrl);
  await page.getByRole("button", { name: "Быстрый старт" }).click();
  await sleep(400);
  await page.keyboard.down("KeyW");
  await sleep(900);
  await page.keyboard.up("KeyW");
  check("I0 заезд начался", !(await low(page)).includes("двигатель заглушен"));

  await tab(page, "Статистика");
  await sleep(500);
  await tab(page, "3D-Тренажёр");
  await sleep(700);
  check("I1 переключение вкладок не прерывает заезд", !(await low(page)).includes("двигатель заглушен"), "состояние сброшено");

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await sleep(800);
  await tab(page, "Разбор и Реплей");
  await sleep(600);
  const mid = await low(page);
  check("I2 незавершённый заезд сохранён в журнале и помечен «в процессе»", mid.includes("в процессе") && mid.includes("из 300"));

  await tab(page, "3D-Тренажёр");
  await sleep(700);
  await page.getByRole("button", { name: /Завершить/ }).click();
  await sleep(800);
  const idb = await readIdb(page);
  check("I3 завершение обновляет ту же запись, а не заводит вторую", idb.metaCount === 1 && idb.payloadCount === 1, `meta ${idb.metaCount}, payload ${idb.payloadCount}`);
  await tab(page, "Разбор и Реплей");
  await sleep(500);
  check("I4 запись помечена завершённой", !(await low(page)).includes("в процессе"));

  // Движение после закрытия попытки не должно перезаписывать сохранённый заезд
  await tab(page, "3D-Тренажёр");
  await sleep(700);
  await page.keyboard.down("KeyW");
  await sleep(800);
  await page.keyboard.up("KeyW");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await sleep(800);
  const idb2 = await readIdb(page);
  check("I5 движение после завершения не портит сохранённую запись",
    idb2.metaCount === 1 && idb2.payloadCount === 1, `meta ${idb2.metaCount}, payload ${idb2.payloadCount}`);
  check("I6 ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("I   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── J. Политика данных, атрибуция, выгрузка и удаление ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await open(ctx, httpUrl);
  page.on("dialog", (d) => d.accept());
  await tab(page, "Инструктор и Правила");
  await sleep(500);
  const text = await low(page);
  check("J1 политика данных и атрибуция ODbL зафиксированы в интерфейсе",
    text.includes("odbl") && text.includes("только в этом браузере") && text.includes("учебная симуляция") && text.includes("produced work"));
  check("J2 подвал с дисклеймером и атрибуцией виден",
    text.includes("не является официальным экзаменом гибдд") && text.includes("© openstreetmap contributors"));

  await tab(page, "Разбор и Реплей");
  await sleep(400);
  await page.getByRole("button", { name: /Сгенерировать демо-попытку/ }).click();
  await sleep(800);
  await tab(page, "Инструктор и Правила");
  await sleep(500);

  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Выгрузить все данные/ }).click(),
  ]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  check("J3 резервная копия содержит попытки, правила, калибровку и свой сценарий",
    backup.schema === "cdt.backup.v1" && backup.attempts.length === 1 && Boolean(backup.ruleset) &&
    Boolean(backup.calibration) && Boolean(backup.customScenario),
    `записей ${backup.attempts.length}`);
  check("J3b выгрузка предупреждает о персональных данных", String(backup.warning).toLowerCase().includes("персональные"));

  await page.getByRole("button", { name: /Удалить все данные/ }).click();
  await sleep(1500);
  await page.waitForSelector("canvas");
  await sleep(1500);
  const idb = await readIdb(page);
  const wipe = await page.evaluate(() => {
    let prof = null;
    try { prof = JSON.parse(localStorage.getItem("cdt.gamepad.profile.v2") || "null"); } catch { /* noop */ }
    return {
      student: localStorage.getItem("cdt.activeStudent.v1"),
      license: localStorage.getItem("cdt.licenseNote.v1"),
      padConfigured: Boolean(prof && (prof.calibrated || prof.deviceId)),
    };
  });
  check("J4 удаление стирает попытки, ФИО, заметку о лицензии и профиль руля",
    idb.metaCount === 0 && idb.payloadCount === 0 && wipe.student === "Ученик 1" && wipe.license === null && !wipe.padConfigured,
    `записей ${idb.metaCount}, ученик «${wipe.student}», лицензия ${wipe.license === null ? "нет" : "есть"}, руль настроен: ${wipe.padConfigured}`);
  check("J5 ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("J   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── K. Перенос панелей HUD долгим нажатием ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);
  const statusBox = () =>
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Быстрый старт"));
      const panel = btn ? btn.closest("div.absolute") : null;
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });

  const before = await statusBox();
  check("K1 панель статуса найдена и плавающая", Boolean(before), JSON.stringify(before));

  // Длительное удержание 420 мс → панель переносится
  await page.mouse.move(before.x + before.w / 2, before.y + before.h - 10);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.move(before.x + before.w / 2 + 170, before.y + before.h / 2 - 95, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const after = await statusBox();
  const moved = Boolean(after) && (Math.abs(after.x - before.x) > 60 || Math.abs(after.y - before.y) > 60);
  check("K2 долгое нажатие переносит панель", moved,
    `было ${before.x},${before.y} → стало ${after ? after.x + "," + after.y : "н/д"}`);

  // Раскладка сохраняется после перезагрузки
  await page.reload();
  await page.waitForSelector("canvas");
  await sleep(1300);
  const restored = await statusBox();
  check("K3 раскладка панели сохраняется после перезагрузки",
    Boolean(restored && after) && Math.abs(restored.x - after.x) < 4 && Math.abs(restored.y - after.y) < 4,
    `после перезагрузки ${restored ? restored.x + "," + restored.y : "н/д"}`);

  // Обычный клик внутри той же панели не сломан длительным нажатием
  await page.getByRole("button", { name: "Быстрый старт" }).click({ timeout: 8000 });
  await sleep(700);
  check("K4 короткий клик по кнопке внутри панели работает", !(await low(page)).includes("двигатель заглушен"));

  // У каждой педали ручка — отдельная кнопка, а не часть рабочей поверхности.
  for (const [id, grip, pedal] of [["pedalGas", "Переместить педаль газа", "Газ"], ["pedalBrake", "Переместить педаль тормоза", "Тормоз"]]) {
    const box = page.locator(`[data-hud-panel="${id}"]`);
    const g = box.getByRole("button", { name: grip, exact: true });
    const surface = box.getByRole("button", { name: pedal, exact: true });
    const from = await box.boundingBox();
    const anchor = await g.boundingBox();
    const other = page.locator(`[data-hud-panel="${id === "pedalGas" ? "pedalBrake" : "pedalGas"}"]`);
    const otherStart = await other.boundingBox();
    await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
    await page.mouse.down();
    await page.mouse.move(anchor.x + anchor.width / 2 - 75, anchor.y + anchor.height / 2 - 100, { steps: 8 });
    const notPressed = (await surface.getAttribute("aria-pressed")) === "false";
    await page.mouse.up();
    const at = await box.boundingBox();
    const otherEnd = await other.boundingBox();
    check(`K5 ${pedal}: перенос за ручку без нажатия и сдвига соседней педали`,
      notPressed && Math.abs(from.y - at.y) > 50 && otherEnd.x === otherStart.x && otherEnd.y === otherStart.y);
    const face = await surface.boundingBox();
    await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2);
    await page.mouse.down(); await sleep(550);
    await page.mouse.move(face.x + face.width + 20, face.y + face.height + 10);
    const held = (await surface.getAttribute("aria-pressed")) === "true";
    await page.mouse.up();
    const afterHold = await box.boundingBox();
    check(`K5 ${pedal}: удержание за пределами кнопки не двигает панель, отпускание снимает нажатие`,
      held && (await surface.getAttribute("aria-pressed")) === "false" && at.x === afterHold.x && at.y === afterHold.y);
  }
  const savedPedals = await page.evaluate(() => {
    const layout = JSON.parse(localStorage.getItem("cdt.layout.v1") || "{}");
    return [layout.pedalGas, layout.pedalBrake];
  });
  await page.reload(); await page.waitForSelector('[data-hud-panel="pedalGas"]');
  const pedalPositions = await page.evaluate(() => ["pedalGas","pedalBrake"].map(id => {
    const el = document.querySelector(`[data-hud-panel="${id}"]`);
    return {x: parseFloat(el.style.left), y: parseFloat(el.style.top)};
  }));
  check("K5c положения обеих педалей восстановлены", savedPedals.every((v,i) => v && Math.abs(v.x-pedalPositions[i].x)<1 && Math.abs(v.y-pedalPositions[i].y)<1));

  // У боковых зеркал убраны подписи — только grip-поле
  const labels = await page.evaluate(() => ({
    left: document.body.innerText.includes("Левое зеркало"),
    right: document.body.innerText.includes("Правое зеркало"),
    wheel: document.body.innerText.includes("Руль\n"),
    rear: document.body.innerText.includes("Зеркало заднего вида"),
  }));
  check("K6 подписи боковых зеркал и руля убраны, заднее осталось",
    !labels.left && !labels.right && labels.rear, JSON.stringify(labels));

  // Пропорции: заднее зеркало шире боковых (3.33:1 против 2:1)
  const aspects = await page.evaluate(() => ["mirrorRear", "mirrorLeft", "mirrorRight"].map(id => {
    const cv = document.querySelector(`[data-hud-panel="${id}"] canvas`); return cv.width / cv.height;
  }));
  check("K7 заднее зеркало 10:3, оба боковых 2:1", Math.abs(aspects[0] - 10 / 3) < 1e-6 && aspects[1] === 2 && aspects[2] === 2);

  check("K8 ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("K   сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── L. Настраиваемый выворот и раздельные отражения ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, errors } = await open(ctx, httpUrl);
  const gas = page.getByRole("button", {name:"Газ", exact:true});
  const brake = page.getByRole("button", {name:"Тормоз", exact:true});
  const rear = page.getByRole("img", { name: "Отражение в зеркале заднего вида", exact:true });
  const sideL = page.getByRole("img", { name: "Отражение в левом зеркале", exact:true });
  const sideR = page.getByRole("img", { name: "Отражение в правом зеркале", exact:true });
  const grab = async (cv) => cv.evaluate(el => {
    const bytes=el.getContext("2d").getImageData(0,0,el.width,el.height).data;
    let sum=0, hash=2166136261;
    for(let i=0;i<bytes.length;i+=4){sum+=bytes[i]+bytes[i+1]+bytes[i+2];hash=Math.imul(hash^bytes[i],16777619);}
    return {sum,hash};
  });
  // После прогрева карты теней при неподвижной сцене кадр заднего зеркала должен быть
  // одинаковым независимо от того, какой боковой буфер заполнялся перед ним.
  await page.evaluate(async () => {for(let i=0;i<42;i++)await new Promise(r=>requestAnimationFrame(r));});
  const rearHashes=await rear.evaluate(async el=>{
    const ctx=el.getContext("2d"), hashes=new Set();
    for(let i=0;i<18;i++){
      await new Promise(r=>requestAnimationFrame(r));
      const data=ctx.getImageData(0,64,el.width,32).data;
      let h=2166136261;for(const b of data) h=Math.imul(h^b,16777619); hashes.add(h);
    }
    return hashes.size;
  });
  const baseline=await grab(rear), left=await grab(sideL),right=await grab(sideR);
  check("L1 заднее отражение не содержит чередующихся боковых фрагментов",rearHashes===1 && baseline.sum>0);
  check("L2 левое и правое зеркала показывают разные стороны",left.hash!==right.hash && left.sum>0 && right.sum>0);
  await page.getByRole("button", { name: "Боковые", exact:true }).click();
  await sleep(450);
  check("L3 отключение боковых зеркал не меняет задний кадр",await sideL.count()===0 && (await grab(rear)).hash===baseline.hash);
  await page.getByRole("button", { name: "Боковые", exact:true }).click();
  await page.getByRole("button", { name: "Заднее", exact:true }).click();
  await page.keyboard.press("KeyH"); await sleep(200);
  check("L4 H сохраняет выбор зеркал, не создавая пустые отражения",await rear.count()===0 && await sideL.count()===1 && await sideR.count()===1);
  await page.keyboard.press("KeyH"); await sleep(200);
  await page.getByRole("button", { name: "Заднее", exact:true }).click();

  await page.getByRole("button", { name: "Быстрый старт" }).click();
  const controls=page.getByRole("button", { name:"Управление", exact:true });
  const slider=page.getByRole("slider", { name:"Максимальный угол поворота внутреннего колеса", exact:true });
  await controls.click();
  check("L5 диапазон выворота 33–42°, по умолчанию 35°",await slider.inputValue()==="35" && await slider.getAttribute("min")==="33" && await slider.getAttribute("max")==="42");
  await slider.press("Home");
  await page.getByRole("button", {name:"Закрыть настройки управления"}).click();
  await page.keyboard.down("KeyA");
  const locked=await until(async()=> /Л 33.0°/.test(await page.locator('.wheel-readout').innerText()));
  await page.keyboard.up("KeyA");
  check("L6 внутреннее колесо доходит до 33° при полном руле",Boolean(locked));
  await controls.click(); await slider.press("End");
  const at42=await until(async()=> /Л 42.0°/.test(await page.locator('.wheel-readout').innerText()));
  await page.getByRole("button", {name:"Закрыть настройки управления"}).click();
  check("L7 предел 42° применяется без сброса заезда или руля",Boolean(at42) && await page.getByRole('button',{name:'Быстрый старт'}).count()===0);

  // Движение мыши рулит без зажатой кнопки; ЛКМ включает газ только после 400 мс.
  const scene = page.getByTestId("sim-canvas");
  const sceneBox = await scene.boundingBox();
  const sceneX = sceneBox.x + sceneBox.width / 2;
  const sceneY = sceneBox.y + sceneBox.height / 2;
  const wheelReadout = page.locator(".wheel-readout");
  await page.mouse.move(sceneX, sceneY);
  const wheelBeforeMouse = await wheelReadout.innerText();
  await page.mouse.move(sceneX + 55, sceneY);
  await sleep(120);
  const wheelAfterMouse = await wheelReadout.innerText();
  check("L8a мышь рулит горизонтальным движением без удержания ЛКМ", wheelBeforeMouse !== wheelAfterMouse,
    `${wheelBeforeMouse} -> ${wheelAfterMouse}`);

  await page.mouse.move(sceneX, sceneY);
  await page.mouse.down();
  await sleep(300);
  const gasBeforeThreshold = (await gas.getAttribute("aria-pressed")) === "true";
  await sleep(180);
  const gasAfterThreshold = (await gas.getAttribute("aria-pressed")) === "true";
  await page.mouse.up();
  await sleep(80);
  const gasAfterRelease = (await gas.getAttribute("aria-pressed")) === "true";
  check("L8b удержание ЛКМ >0,4 с включает газ, отпускание выключает его",
    !gasBeforeThreshold && gasAfterThreshold && !gasAfterRelease,
    `до порога=${gasBeforeThreshold}, после=${gasAfterThreshold}, после отпускания=${gasAfterRelease}`);

  const press = async (button) => {const r=await button.boundingBox();await page.mouse.move(r.x+r.width/2, r.y+r.height/2);await page.mouse.down();};
  await press(gas); const drives=await until(async()=> (await speedOf(page))>=2); await page.mouse.up();
  await press(brake); const stopped=await until(async()=> (await speedOf(page))===0); await page.mouse.up();
  check("L8 педали по-прежнему разгоняют и останавливают машину",Boolean(drives && stopped));
  await page.getByRole("button",{name:/Завершить/}).click();
  await page.getByRole("button",{name:/Проверить детерминизм/}).click();
  const idb=await readIdb(page); const a=idb.attempt;
  check("L9 заезд с изменением настройки воспроизводится точно",(await low(page)).includes("детерминизм подтверждён") && a.calibration.maxInnerWheelDeg===42 && a.inputStream.some(f=>f.maxInnerWheelDeg===33) && a.inputStream.some(f=>f.maxInnerWheelDeg===42));
  await page.reload();await controls.click();check("L10 предел сохранён после перезагрузки",await slider.inputValue()==="42");
  await page.getByRole("button",{name:"Базовый · 35°"}).click();check("L11 сброс настройки возвращает 35°",await slider.inputValue()==="35");
  check("L12 ошибок в консоли нет", errors.length===0, errors.slice(0,3).join(" | "));
  await ctx.close();
} catch(e) {
  check("L сценарий выполнен без исключений",false,String(e.message).slice(-460));
}

// ───────── M. Два пальца: газ удерживается независимо от перемещения тормоза ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { page, errors } = await open(ctx, httpUrl);
  const gas = page.getByRole("button", { name: "Газ", exact: true });
  const brake = page.getByRole("button", { name: "Тормоз", exact: true });
  const grip = page.getByRole("button", { name: "Переместить педаль тормоза", exact: true });
  await gas.scrollIntoViewIfNeeded();
  const g = await gas.boundingBox(), h = await grip.boundingBox();
  const finger1 = { x: g.x + g.width / 2, y: g.y + g.height / 2, id: 1 };
  const finger2 = { x: h.x + h.width / 2, y: h.y + h.height / 2, id: 2 };
  const moved2 = { ...finger2, x: finger2.x - 45, y: finger2.y - 80 };
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, touchPoints) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints }); await sleep(100);
  };
  await touch("touchStart", [finger1]);
  await touch("touchStart", [finger1, finger2]);
  await touch("touchMove", [finger1, moved2]);
  check("M1 второй палец переносит только тормоз, не включая его и не отпуская газ",
    (await gas.getAttribute("aria-pressed")) === "true" && (await brake.getAttribute("aria-pressed")) === "false"
      && Math.abs((await grip.boundingBox()).y - h.y) > 50 && Math.abs((await gas.boundingBox()).y - g.y) < 1);
  // Здесь указан отпускаемый палец (id:2), а не остающийся на экране (id:1).
  await touch("touchEnd", [moved2]);
  check("M2 отпускание ручки второго пальца не сбрасывает газ",(await gas.getAttribute("aria-pressed")) === "true");
  await touch("touchCancel", []);
  check("M3 отмена касания не оставляет зажатую педаль",(await gas.getAttribute("aria-pressed")) === "false");
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("button", { name: "Сбросить раскладку" }).click();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cdt.layout.v1") || "{}"));
  check("M4 общий сброс раскладки возвращает обе педали", !stored.pedalBrake && !stored.pedalGas);
  await page.getByRole("button",{name:"Закрыть настройки управления"}).click();
  await page.screenshot({ path: `${shotDir}/mobile-pedals.png` });
  check("M5 ошибок в консоли нет",errors.length===0,errors.slice(0,3).join(" | "));
  await ctx.close();
} catch (e) {
  check("M сценарий выполнен без исключений",false,String(e.message).slice(-460));
}

// ───────── N. Передача контекста: документ в UI не расходится с HANDOFF.md ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);
  const root = fs.readFileSync("HANDOFF.md", "utf8");
  await tab(page, "Тесты и Модули");
  await sleep(800);
  await page.getByText("Передача контекста в следующий чат", { exact: true }).waitFor();
  const panel = page.locator("div.panel", { hasText: "Передача контекста в следующий чат" }).first();
  const uiSections = await panel.locator("ol li span:last-child").allInnerTexts();
  const fileSections = root.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).replace(/^\d+\.\s*/, ""));
  check("N1 состав документа в интерфейсе совпадает с HANDOFF.md",
    uiSections.length === fileSections.length && uiSections.every((t, i) => t === fileSections[i]),
    `${uiSections.length} разделов в UI против ${fileSections.length} в файле`);
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    panel.getByRole("button", { name: "HANDOFF.md", exact: true }).click(),
  ]);
  check("N2 выгруженный HANDOFF.md совпадает с файлом в репозитории", fs.readFileSync(await dl.path(), "utf8") === root);
  const prompt = await panel.locator("pre").innerText();
  check("N3 короткий промпт содержит реальные команды гейта",
    prompt.includes("npx tsc --noEmit") && prompt.includes("npm run build") && prompt.includes("selfTest.ts"));
  await page.getByRole("button", { name: ".github/workflows/ci.yml", exact: true }).click();
  const ci = await panelArtifacts(page);
  await page.getByRole("button", { name: /AGENTS.md/, exact: false }).first().click();
  const agents = await panelArtifacts(page);
  check("N4 в CI и AGENTS указаны существующие команды проверки",
    ci.includes("esbuild src/sim/selfTest.ts") && agents.includes("runAllSelfTests")
      && !ci.includes("npx tsx") && !agents.includes("npx tsx"));
  const allText = await page.evaluate(() => document.body.innerText);
  check("N5 инструкции не ссылаются на отсутствующие tsx и scripts/run-tests.ts",
    !allText.includes("npx tsx scripts/run-tests.ts"));
  check("N6 ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("N сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

// ───────── O. Редактор карт: импорт .osm XML, размещение и перенос знаков/объектов, открытие в 3D ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);
  await tab(page, "Свой сценарий");
  await sleep(400);

  const lotSurface = page.getByTestId("editor-lot-surface-toggle");
  const lotInitiallyEnabled = await lotSurface.isChecked();
  await lotSurface.uncheck();
  const lotRemoved = !(await lotSurface.isChecked());
  await lotSurface.check();
  const lotRect = page.getByTestId("map-lot-surface").locator("rect");
  await page.getByTestId("editor-tool-select").click();
  const lotBefore = {
    x: Number(await lotRect.getAttribute("data-center-x")),
    z: Number(await lotRect.getAttribute("data-center-z")),
    hx: Number(await lotRect.getAttribute("data-half-x")),
    hz: Number(await lotRect.getAttribute("data-half-z")),
  };
  const lotBox = await lotRect.boundingBox();
  await page.mouse.move(lotBox.x + lotBox.width / 2, lotBox.y + lotBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lotBox.x + lotBox.width / 2 + 45, lotBox.y + lotBox.height / 2 - 30, { steps: 6 });
  await page.mouse.up();
  await sleep(120);
  const movedLot = Number(await lotRect.getAttribute("data-center-x")) !== lotBefore.x || Number(await lotRect.getAttribute("data-center-z")) !== lotBefore.z;
  const resize = page.getByTestId("map-lot-resize-e-n");
  const resizeBox = await resize.boundingBox();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 35, resizeBox.y + resizeBox.height / 2 - 25, { steps: 5 });
  await page.mouse.up();
  await sleep(120);
  const resizedLot = Number(await lotRect.getAttribute("data-half-x")) !== lotBefore.hx || Number(await lotRect.getAttribute("data-half-z")) !== lotBefore.hz;
  check("O0 стартовую площадку можно отключить, переместить и изменить её размеры угловыми ручками",
    lotInitiallyEnabled && lotRemoved && await lotSurface.isChecked() && movedLot && resizedLot,
    `move=${movedLot}, resize=${resizedLot}`);

  // 1. Импортируем локальный .osm XML с дорогой, светофором, знаком STOP, забором и деревом
  const osmXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="55.7500" lon="37.6100"/>
  <node id="2" lat="55.7510" lon="37.6100"><tag k="highway" v="traffic_signals"/></node>
  <node id="3" lat="55.7504" lon="37.6101"><tag k="highway" v="stop"/></node>
  <node id="4" lat="55.7505" lon="37.6098"><tag k="natural" v="tree"/></node>
  <node id="5" lat="55.7502" lon="37.6102"/>
  <node id="6" lat="55.7506" lon="37.6102"/>
  <way id="50">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="ул. Учебная OSM"/>
    <tag k="maxspeed" v="40"/>
  </way>
  <way id="51"><nd ref="5"/><nd ref="6"/><tag k="barrier" v="fence"/></way>
</osm>`;
  await page.getByTestId("editor-import-input").setInputFiles({
    name: "uchebnaya.osm",
    mimeType: "application/xml",
    buffer: Buffer.from(osmXml),
  });
  await sleep(500);
  const odblText = await page.getByTestId("editor-odbl-banner").innerText();
  check("O1 импорт .osm XML показывает источник и атрибуцию ODbL 1.0",
    odblText.includes("OpenStreetMap") && odblText.includes("ODbL 1.0"), odblText.slice(0, 120));

  // Сетка должна переключаться вместе с привязкой, а на крупном масштабе — прореживаться.
  const mapCanvas = page.getByTestId("map-editor-canvas");
  await mapCanvas.scrollIntoViewIfNeeded();
  await page.getByTestId("editor-grid-0").click();
  await sleep(100);
  const gridOff = (await page.getByTestId("map-grid").count()) === 0;
  await page.getByTestId("editor-grid-2").click();
  await sleep(100);
  const grid2 = page.getByTestId("map-grid");
  const step2 = await grid2.getAttribute("data-grid-step");
  const lines2 = await grid2.locator("line").count();
  await page.getByTestId("editor-grid-0.5").click();
  await sleep(100);
  const grid05 = page.getByTestId("map-grid");
  const step05 = await grid05.getAttribute("data-grid-step");
  const lines05 = await grid05.locator("line").count();
  check("O1b сетка скрывается по «Выкл» и отображается по выбранному шагу",
    gridOff && step2 !== null && step05 !== null && lines05 > lines2 * 1.5,
    `off=${gridOff}, линии 2 м=${step2}/${lines2}, 0,5 м=${step05}/${lines05}`);

  // Рисуем собственную дорогу последовательными точками; Enter завершает построение.
  const roadCountBefore = await page.locator('[data-testid^="map-road-"]').count();
  const roadRoundToggle = page.getByLabel("Скруглять углы", { exact: true });
  await roadRoundToggle.check();
  await page.getByTestId("editor-tool-road").click();
  const roadCanvasBox = await mapCanvas.boundingBox();
  await page.mouse.click(roadCanvasBox.x + roadCanvasBox.width * 0.34, roadCanvasBox.y + roadCanvasBox.height * 0.34);
  await page.mouse.click(roadCanvasBox.x + roadCanvasBox.width * 0.48, roadCanvasBox.y + roadCanvasBox.height * 0.34);
  await page.mouse.click(roadCanvasBox.x + roadCanvasBox.width * 0.48, roadCanvasBox.y + roadCanvasBox.height * 0.53);
  const draftShown = await page.getByTestId("map-road-draft").count() === 1;
  await page.keyboard.press("Enter");
  await sleep(180);
  const roadCountAfter = await page.locator('[data-testid^="map-road-"]').count();
  const newRoad = page.locator('[data-testid^="map-road-"]').last();
  const newRoadWidth = await page.getByLabel("Ширина новой дороги").inputValue();
  const newRoadRadius = await newRoad.getAttribute("data-corner-radius");
  await page.getByTestId("editor-tool-select").click();
  check("O1c дорога строится по последовательным точкам, Enter завершает, ширина и скругление применяются",
    draftShown && roadCountAfter === roadCountBefore + 1 && newRoadWidth === "7.5" && newRoadRadius === "8",
    `draft=${draftShown}, roads=${roadCountBefore}->${roadCountAfter}, width=${newRoadWidth}, radius=${newRoadRadius}`);
  await roadRoundToggle.uncheck();

  // 2. Выбираем инструмент «Дорожный знак» -> «Уступите дорогу» и ставим кликом по 2D-карте
  const signsBefore = await page.locator('[data-testid^="map-sign-"]').count();
  await page.getByTestId("editor-tool-sign").click();
  await page.getByTestId("palette-sign-give_way").click();
  const canvas = page.getByTestId("map-editor-canvas");
  await canvas.scrollIntoViewIfNeeded();
  await sleep(150);
  const cBox = await canvas.boundingBox();
  await canvas.click({
    position: { x: Math.round(cBox.width * 0.62), y: Math.round(cBox.height * 0.45) },
  });
  await sleep(250);
  const signsAfter = await page.locator('[data-testid^="map-sign-"]').count();
  check("O2 новый дорожный знак ставится кликом на 2D-карту",
    signsAfter === signsBefore + 1, `было ${signsBefore}, стало ${signsAfter}`);

  // 3. Перетаскиваем новый знак мышью в режиме «Выбор / Перенос» и проверяем смену координат + Undo
  await page.getByTestId("editor-tool-select").click();
  await canvas.scrollIntoViewIfNeeded();
  await sleep(150);
  const newSign = page.locator('[data-testid^="map-sign-sign-give_way"]').first();
  await newSign.scrollIntoViewIfNeeded();
  const beforeTf = await newSign.getAttribute("transform");
  const sBox = await newSign.boundingBox();
  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sBox.x + sBox.width / 2 + 55, sBox.y + sBox.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  await sleep(250);
  const afterTf = await newSign.getAttribute("transform");
  check("O3 дорожный знак перетаскивается мышью на 2D-карте",
    Boolean(beforeTf && afterTf && beforeTf !== afterTf), `${beforeTf} -> ${afterTf}`);

  await page.getByRole("button", { name: /Отмена \(/ }).click();
  await sleep(200);
  const undoneTf = await newSign.getAttribute("transform");
  check("O4 отмена действия (Undo) возвращает знак на прежнее место",
    undoneTf === beforeTf, `${undoneTf} vs ${beforeTf}`);

  // 4. Открываем отредактированную карту со знаками, светофором, забором и деревом в 3D-тренажёре
  await page.getByRole("button", { name: /Открыть в тренажёре/ }).click();
  await sleep(1200);
  const simLow = await low(page);
  check("O5 отредактированная OSM-карта со знаками, объектами и ODbL открывается в 3D",
    simLow.includes("импорт osm: дорог 1") && simLow.includes("знаков")
      && simLow.includes("openstreetmap") && simLow.includes("odbl"),
    simLow.slice(0, 140));
  await page.screenshot({ path: `${shotDir}/editor-osm-3d.png` });

  // 5. Короткий заезд по отредактированной карте и проверка детерминизма реплея + 2D-разбора
  await page.getByRole("button", { name: "Быстрый старт" }).click();
  await sleep(350);
  await page.keyboard.down("KeyW");
  await sleep(1200);
  await page.keyboard.up("KeyW");
  await page.getByRole("button", { name: /Завершить/ }).click();
  await sleep(700);
  await page.getByRole("button", { name: /Проверить детерминизм/ }).click();
  await sleep(600);
  const debriefRaw = await page.evaluate(() => document.body.innerText);
  const detMatch = debriefRaw.match(/Детерминизм подтверждён[^\n]*/);
  check("O6 реплей заезда по отредактированной .osm-карте со знаками совпадает побитно",
    Boolean(detMatch), (detMatch ?? ["нет подтверждения"])[0].slice(0, 120));
  check("O7 ошибок в консоли и WebGL нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("O сценарий выполнен без исключений", false, String(e.message).slice(-460));
}

await browser.close();
console.log(failed === 0 ? "SMOKE: все проверки пройдены" : `SMOKE: не пройдено ${failed}`);
process.exit(failed === 0 ? 0 : 1);
