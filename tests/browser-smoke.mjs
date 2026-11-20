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
  if (!ok) {
    failed++;
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error title=SMOKE::${name}${extra ? " — " + extra.replace(/\r?\n/g, " ") : ""}`);
    }
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chromium: в CI — установленный Playwright; локально/в песочнице — бинарь из npm-пакета
// (`CDT_CHROMIUM_PATH`), если CDN Playwright недоступен. Оба пути дают тот же headless-движок.
const browser = await chromium.launch({
  executablePath: process.env.CDT_CHROMIUM_PATH || undefined,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

async function open(ctx, url) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Сетевые ошибки живого интернет-эфира ШГУ в закрытом окружении CI — не дефект приложения:
    // плеер обязан честно показать «эфир недоступен» и не ронять тренажёр.
    if (/Failed to load resource|MEDIA_ELEMENT_ERROR|net::ERR/i.test(text)) return;
    errors.push("console.error: " + text.slice(0, 200));
  });
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
// Keep the locator/action that timed out, not just the tail of Playwright's retry log.
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
  await page.setViewportSize({ width: 1200, height: 900 });
  const toolbarRow = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="sim-toolbar"]');
    const boxes = [...bar.querySelectorAll("button")].filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect());
    const centers = boxes.map(b => b.y + b.height / 2);
    return { height: bar.getBoundingClientRect().height, spread: Math.max(...centers) - Math.min(...centers),
      fits: bar.scrollWidth <= bar.clientWidth + 1,
      renamed: bar.innerText.includes("Параллельная") && !bar.innerText.includes("(v2)") };
  });
  check("A2n scenario/actions toolbar fits in one compact row at 1200px", toolbarRow.height <= 40 && toolbarRow.spread < 3 && toolbarRow.fits && toolbarRow.renamed, JSON.stringify(toolbarRow));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${shotDir}/layout.png` });

  // Fullscreen remains usable in embedded previews even when the browser denies the API.
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="sim-viewport"]');
    Object.defineProperty(host, "requestFullscreen", { configurable: true,
      value: () => Promise.reject(new Error("Fullscreen denied by iframe policy")) });
  });
  await page.getByTestId("sim-fullscreen-enter").click();
  await until(() => page.evaluate(() => {
    const host = document.querySelector('[data-testid="sim-viewport"]');
    const r = host.getBoundingClientRect();
    return host.dataset.immersive === "true" && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
  }), 5000);
  const full = await page.getByTestId("sim-viewport").boundingBox();
  check("A2e fullscreen fallback fills viewport and hides HUD",
    Math.abs(full.width - 1440) < 2 && Math.abs(full.height - 900) < 2 &&
    await page.locator('[data-hud-panel="scorePanel"]').count() === 0);
  await page.keyboard.press("Escape");
  await until(() => page.evaluate(() => document.querySelector('[data-testid="sim-viewport"]')?.dataset.immersive === "false"), 5000);
  check("A2f Esc exits fullscreen and restores HUD", await page.locator('[data-hud-panel="scorePanel"]').count() === 1);
  await page.getByTestId("sim-fullscreen-enter").click();
  await page.getByTestId("sim-fullscreen-exit").click();
  check("A2g fullscreen exit button works without native API",
    await page.getByTestId("sim-viewport").getAttribute("data-immersive") === "false");

  // HUD hiding is independent of fullscreen and has an always reachable restore control.
  await page.getByTestId("sim-hud-toggle").click();
  check("A2h HUD can be hidden without entering fullscreen",
    await page.getByTestId("sim-viewport").getAttribute("data-immersive") === "false" && await page.locator('[data-hud-panel="scorePanel"]').count() === 0);
  await page.getByTestId("sim-hud-toggle").click();
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByTestId("keybindings-editor").locator("summary").click();
  await page.getByRole("button", { name: "Назначить: Газ", exact: true }).click();
  await page.keyboard.press("KeyS");
  const conflictMessage = await page.getByTestId("keybindings-message").innerText();
  const rejectedKeys = await page.evaluate(() => JSON.parse(localStorage.getItem("cdt.keybindings.v1") || "{}"));
  check("A2o occupied brake key cannot also become throttle", conflictMessage.includes("уже назначена") && rejectedKeys.KeyW === "KeyW" && rejectedKeys.KeyS === "KeyS");
  // Free Space, then assign it to fullscreen. Native HTML activation must NOT fire too.
  await page.getByRole("button", { name: "Назначить: Ручник", exact: true }).click();
  await page.keyboard.press("KeyT");
  await page.getByRole("button", { name: "Назначить: Полный экран", exact: true }).click();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Закрыть настройки управления", exact: true }).click();
  await page.getByTestId("sim-hud-toggle").focus();
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  check("A2p remapped Space runs one action, not native button click or autorepeat",
    await page.getByTestId("sim-viewport").getAttribute("data-immersive") === "true" &&
    await page.locator('[data-hud-panel="scorePanel"]').count() === 0);
  await page.keyboard.up("Space");
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByTestId("keybindings-editor").locator("summary").click();
  await page.getByRole("button", { name: "Сбросить назначения клавиш", exact: true }).click();
  await page.getByRole("button", { name: "Назначить: Полный экран", exact: true }).click();
  await page.keyboard.press("KeyY");
  await page.getByRole("button", { name: "Закрыть настройки управления", exact: true }).click();
  await page.keyboard.press("KeyU");
  check("A2i old fullscreen binding is disabled", await page.getByTestId("sim-viewport").getAttribute("data-immersive") === "false");
  await page.keyboard.press("KeyY");
  check("A2j remapped fullscreen key works", await page.getByTestId("sim-viewport").getAttribute("data-immersive") === "true");
  await page.keyboard.press("KeyY");
  const savedKeys = await page.evaluate(() => JSON.parse(localStorage.getItem("cdt.keybindings.v1") || "{}"));
  check("A2k bindings persisted", savedKeys.KeyU === "KeyY");
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByTestId("keybindings-editor").locator("summary").click();
  await page.getByRole("button", { name: "Сбросить назначения клавиш", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть настройки управления", exact: true }).click();
  const expandedViewport = await page.getByTestId("sim-viewport").boundingBox();
  await page.getByTestId("sim-menus-toggle").click();
  const compactViewport = await page.getByTestId("sim-viewport").boundingBox();
  check("A2l one toggle hides both menus and returns their space to the scene",
    !(await page.getByTestId("app-header").isVisible()) && !(await page.getByTestId("sim-toolbar").isVisible()) &&
    compactViewport.y <= 10 && compactViewport.height > expandedViewport.height);
  await page.getByTestId("sim-menus-toggle").click();
  check("A2m menus can be restored from the scene",
    await page.getByTestId("app-header").isVisible() && await page.getByTestId("sim-toolbar").isVisible());
  await page.evaluate(() => { delete document.querySelector('[data-testid="sim-viewport"]').requestFullscreen; });
  // Deterministic reproduction: fullscreen API resolves only after the user has exited.
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="sim-viewport"]');
    window.__lateFullscreen = { exited: 0, originalExit: document.exitFullscreen,
      originalElement: Object.getOwnPropertyDescriptor(document, "fullscreenElement") };
    Object.defineProperty(host, "requestFullscreen", { configurable: true, value: () => new Promise(resolve => {
      window.__lateFullscreen.resolve = () => {
        Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => host });
        document.exitFullscreen = () => { window.__lateFullscreen.exited++; return Promise.resolve(); };
        resolve();
      };
    }) });
  });
  await page.getByTestId("sim-fullscreen-enter").click();
  await page.getByTestId("sim-fullscreen-exit").click();
  await page.evaluate(() => window.__lateFullscreen.resolve());
  check("A2q запоздавший fullscreen-запрос отменяется после выхода", await until(() =>
    page.evaluate(() => window.__lateFullscreen.exited === 1), 5000));
  await page.evaluate(() => {
    const saved = window.__lateFullscreen;
    document.exitFullscreen = saved.originalExit;
    if (saved.originalElement) Object.defineProperty(document, "fullscreenElement", saved.originalElement);
    else delete document.fullscreenElement;
    delete document.querySelector('[data-testid="sim-viewport"]').requestFullscreen;
    delete window.__lateFullscreen;
  });



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

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  const m2Shown = await until(async () => /\bM2\b/.test(await page.evaluate(() => document.body.innerText)), 5000);
  await page.keyboard.press("Shift+ArrowDown");
  const m1Shown = await until(async () => /\bM1\b/.test(await page.evaluate(() => document.body.innerText)), 5000);
  await page.keyboard.press("KeyF");
  const d1Shown = await until(async () => /\bD1\b/.test(await page.evaluate(() => document.body.innerText)), 5000);
  check("A4b стрелки и Shift+стрелки переключают КПП (R→N→M1→M2→M1), F возвращает D1", m2Shown && m1Shown && d1Shown, `M2=${m2Shown} M1=${m1Shown} D1=${d1Shown}`);

  // A4c: Shift при нажатом тормозе — режим энергичного торможения, а не переключение передачи вверх
  await page.keyboard.down("KeyS");
  await sleep(140);
  const gearBeforeShiftBrake = await page.evaluate(() => window.__cdtCockpit?.gear?.() ?? "");
  await page.keyboard.press("ShiftLeft");
  await sleep(200);
  const brakePosBoost = await page.evaluate(() => window.__cdtCockpit?.state?.()?.brakePos ?? 0);
  await page.keyboard.up("KeyS");
  check("A4c Shift + тормоз усиливает давление в гидроприводе и не переключает передачу вверх",
    brakePosBoost > 0.05 && gearBeforeShiftBrake === "D", JSON.stringify({ brakePosBoost, gearBeforeShiftBrake }));

  // H — сигнал (клаксон), HUD прячет U: разделяем роли, чтобы одна клавиша не делала двух дел
  await page.keyboard.press("KeyU");
  await sleep(500);
  text = await low(page);
  const uFullscreen = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="sim-viewport"]');
    const r = el.getBoundingClientRect();
    return el.dataset.immersive === "true" && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
  });
  check("A5 клавиша U включает полный экран, а не просто скрывает HUD",
    uFullscreen && !text.includes("км/ч") && text.includes("зеркало заднего вида"));
  await page.keyboard.press("KeyU");
  const uRestored = await until(() => page.evaluate(() => document.querySelector('[data-testid="sim-viewport"]')?.dataset.immersive === "false"), 5000);
  check("A5b повторное U выходит из fullscreen и восстанавливает интерфейс", uRestored && await page.locator('[data-hud-panel="scorePanel"]').count() === 1);
  await sleep(300);

  // An async native request must not put the scene back in the top layer after exit.
  const nativeExited = await until(() => page.evaluate(() => !document.fullscreenElement), 10000);
  check("A5c выход из fullscreen убирает сцену из верхнего слоя браузера", nativeExited);
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

  await page.getByTestId("debrief-new-attempt").click();
  const freshAttempt = await until(() => page.evaluate(() => {
    const api = window.__cdtCockpit;
    const st = api?.state?.();
    return st && api.engineOn() === false && api.gear() === "P" && st.v === 0 && st.collisions === 0 &&
      st.hasMoved === false && st.handbrake === true && !st.finished;
  }), 5000);
  check("A8b Новый заезд creates a cold-start attempt, not just a tab switch", freshAttempt);

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
  check("A   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("B   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("C   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("D   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("F   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("G   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("E   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("H   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
}

// ───────── I. Заезд переживает переключение вкладок и закрытие страницы ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await open(ctx, httpUrl);
  await page.getByRole("button", { name: "Быстрый старт" }).click();
  await sleep(400);
  await page.keyboard.down("KeyW");
  // Autosave intentionally ignores attempts that have not actually moved (>1.2 km/h).
  // Wait for motion, not a wall-clock delay that can expire during a slow SwiftShader frame.
  const rideStarted = await until(async () => (await speedOf(page)) >= 3, 20000);
  await page.keyboard.up("KeyW");
  check("I0 заезд действительно начался (скорость ≥3 км/ч)", rideStarted);

  await tab(page, "Статистика");
  await sleep(500);
  await tab(page, "3D-Тренажёр");
  await sleep(700);
  check("I1 переключение вкладок не прерывает заезд", !(await low(page)).includes("двигатель заглушен"));

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const unfinishedSaved = await until(async () => (await readIdb(page)).metaCount === 1, 10000);
  await tab(page, "Разбор и Реплей");
  const unfinishedVisible = await until(async () => {
    const mid = await low(page);
    return mid.includes("в процессе") && mid.includes("из 300");
  }, 10000);
  check("I2 незавершённый заезд сохранён в журнале и помечен «в процессе»", unfinishedSaved && unfinishedVisible);

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
  check("I   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  check("J   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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

  // Длительное удержание 420 мс → панель переносится.
  // Ждём фактического «взведения» (data-front=true), а не фиксированные 700 мс: под SwiftShader
  // первый кадр после pointerdown может занять несколько сотен мс, и шаг мыши отменял нажатие (K2 падал).
  const statusPanel = page.locator('[data-hud-panel="statusBar"]');
  await page.mouse.move(before.x + before.w / 2, before.y + before.h - 10);
  await page.mouse.down();
  const statusArmed = await until(async () => (await statusPanel.getAttribute("data-front")) === "true", 5000);
  await page.mouse.move(before.x + before.w / 2 + 170, before.y + before.h / 2 - 95, { steps: 10 });
  await sleep(120);
  await page.mouse.up();
  await sleep(400);
  const after = await statusBox();
  const moved = Boolean(after) && (Math.abs(after.x - before.x) > 60 || Math.abs(after.y - before.y) > 60);
  check("K2 долгое нажатие переносит панель", statusArmed === true && moved,
    `взведена: ${statusArmed}, было ${before.x},${before.y} → стало ${after ? after.x + "," + after.y : "н/д"}`);

  // Длительное нажатие выводит панель на передний план/слой поверх всех остальных HUD-панелей (даже без переноса)
  const frontAfterDrag = await page.evaluate(() => {
    const panels = [...document.querySelectorAll("[data-hud-panel]")];
    const zOf = (id) => Number(document.querySelector(`[data-hud-panel="${id}"]`)?.style.zIndex || 0);
    const maxZ = Math.max(...panels.map((el) => Number(el.style.zIndex || 0)));
    return { statusZ: zOf("statusBar"), maxZ, front: document.querySelector('[data-hud-panel="statusBar"]')?.getAttribute("data-front") };
  });
  check("K2b длительное нажатие помещает панель на самый верхний слой",
    frontAfterDrag.statusZ === frontAfterDrag.maxZ && frontAfterDrag.statusZ >= 28 && frontAfterDrag.front === "true",
    JSON.stringify(frontAfterDrag));

  // Раскладка и передний слой сохраняются после перезагрузки
  await page.reload();
  await page.waitForSelector("canvas");
  // Панель обязана вернуться на сохранённое место: ждём совпадения, а не фиксированную паузу.
  const restored = await until(async () => {
    const box = await statusBox();
    return box && after && Math.abs(box.x - after.x) < 4 && Math.abs(box.y - after.y) < 4 ? box : null;
  }, 8000) ?? (await statusBox());
  const frontRestored = await page.evaluate(() => {
    const el = document.querySelector('[data-hud-panel="statusBar"]');
    return { z: Number(el?.style.zIndex || 0), front: el?.getAttribute("data-front") };
  });
  check("K3 раскладка и передний слой панели сохраняются после перезагрузки",
    Boolean(restored && after) && Math.abs(restored.x - after.x) < 4 && Math.abs(restored.y - after.y) < 4
      && frontRestored.z >= 28 && frontRestored.front === "true",
    `после перезагрузки ${restored ? restored.x + "," + restored.y : "н/д"} z=${frontRestored.z}`);

  // Длительный тап/клик без сдвига на scorePanel (baseZ=20) выводит её поверх statusBar
  const scorePanel = page.locator('[data-hud-panel="scorePanel"]');
  await scorePanel.scrollIntoViewIfNeeded();
  const scoreRect = await scorePanel.boundingBox();
  await page.mouse.move(scoreRect.x + 28, scoreRect.y + Math.min(22, scoreRect.height / 2));
  await page.mouse.down();
  await until(async () => (await scorePanel.getAttribute("data-front")) === "true", 3000);
  await page.mouse.up();
  await sleep(350);
  const scoreAfter = await scorePanel.boundingBox();
  const scoreFront = await page.evaluate(() => ({
    scoreZ: Number(document.querySelector('[data-hud-panel="scorePanel"]')?.style.zIndex || 0),
    statusZ: Number(document.querySelector('[data-hud-panel="statusBar"]')?.style.zIndex || 0),
    front: document.querySelector('[data-hud-panel="scorePanel"]')?.getAttribute("data-front"),
  }));
  const stayedInPlace = Boolean(scoreAfter)
    && Math.abs(scoreAfter.x - scoreRect.x) < 2
    && Math.abs(scoreAfter.y - scoreRect.y) < 2;
  check("K3b длительный клик без переноса выводит scorePanel поверх ранее поднятой панели",
    scoreFront.scoreZ > scoreFront.statusZ && scoreFront.front === "true" && stayedInPlace,
    JSON.stringify({ ...scoreFront, stayedInPlace }));

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

  // Сворачивание (−), разворачивание (+), закрытие (×) и восстановление через док «Окна»
  const scoreFull = await page.locator('[data-hud-panel="scorePanel"]').boundingBox();
  await page.getByRole("button", { name: "Свернуть: Оценка", exact: true }).click();
  await sleep(120);
  const scoreMin = await page.locator('[data-hud-panel="scorePanel"]').boundingBox();
  const isMin = (await page.locator('[data-hud-panel="scorePanel"]').getAttribute("data-collapsed")) === "true";
  await page.getByRole("button", { name: "Развернуть: Оценка", exact: true }).click();
  await sleep(120);
  const scoreBack = await page.locator('[data-hud-panel="scorePanel"]').boundingBox();
  await page.getByRole("button", { name: "Закрыть: Оценка", exact: true }).click();
  await sleep(120);
  const closedGone = (await page.locator('[data-hud-panel="scorePanel"]').count()) === 0;
  await page.getByTestId("hud-restore-dock").click();
  await page.getByTestId("hud-panels-menu").getByRole("button", { name: "Показать все", exact: true }).click();
  await sleep(120);
  const reopened = (await page.locator('[data-hud-panel="scorePanel"]').count()) === 1;
  check("K7b элементы HUD сворачиваются (−/+), закрываются (×) и возвращаются через «Окна»",
    Boolean(isMin && scoreMin && scoreFull && scoreMin.height < scoreFull.height - 10 && scoreBack && scoreBack.height >= scoreFull.height - 2 && closedGone && reopened),
    JSON.stringify({ isMin, fullH: scoreFull?.height, minH: scoreMin?.height, closedGone, reopened }));

  // Подсказка КПП при наведении на HUD и живое переключение передач 3D-рычагом АКПП в салоне
  // (возвращаем statusBar с центра холста после K2 на штатное место, чтобы не перекрывал центр 3D-салона)
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("button", { name: "Сбросить раскладку" }).click();
  await page.getByRole("button", { name: "Закрыть настройки управления" }).click();
  await sleep(120);
  const canvasEl = page.locator("canvas").first();
  await canvasEl.scrollIntoViewIfNeeded();
  const hudDriveBtn = page.locator('[data-gear-slot="D"]');
  await hudDriveBtn.hover();
  await sleep(120);
  const hudHintText = (await page.locator('[data-testid="hud-gearbox-hint"]').innerText().catch(() => "")).replace(/\s+/g, " ");
  const hudHintOk = hudHintText.includes("6АКПП") && hudHintText.includes("Shift") && hudHintText.includes("M1–M6") && hudHintText.includes("3D-рычаг");
  // Переходим к 3D-рычагу АКПП в салоне (G) и заводим ДВС (I)
  await page.keyboard.press("KeyG");
  await page.locator('[data-testid="cockpit-look-shifter"]').waitFor({ timeout: 5000 });
  await page.keyboard.press("KeyI");
  // Дожидаемся двух полных кадров rAF после переключения камеры в салон под SwiftShader
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(160);
  const cvBox = await canvasEl.boundingBox();
  // Точки органов берём из отладочного моста (реальный raycast/проекция), а не долями экрана:
  // кадр салона меняется вместе с компоновкой (image-6.png), и фиксированные доли перестают попадать.
  const toPx = (p) => ({ x: cvBox.x + cvBox.width * p.normX, y: cvBox.y + cvBox.height * p.normY });
  const settleHead = () => until(() => page.evaluate(() => window.__cdtCockpit?.headSettled?.() ?? true), 6000, 120);
  const shifterPx = async (id) => {
    const p = await page.evaluate((sid) => window.__cdtCockpit?.shifterPoint?.(sid) ?? null, id);
    return p ? toPx(p) : null;
  };
  const shifterSettled = await settleHead();
  const knobPx = await shifterPx("lever");
  if (!knobPx) throw new Error("Рукоятка КПП вне кадра");
  const dragPx = async (id) => {
    const p = await page.evaluate((sid) => window.__cdtCockpit?.shifterDragPoint?.(sid) ?? null, id);
    if (!p) throw new Error(`Нет drag-цели ${id}: рычаг не захвачен или цель вне кадра`);
    return toPx(p);
  };
  const topTag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName || "NONE", knobPx);
  const knobPick = await page.evaluate(({ x, y }) => window.__cdtCockpit?.pickAt?.(x, y), {
    x: (knobPx.x - cvBox.x) / cvBox.width, y: (knobPx.y - cvBox.y) / cvBox.height,
  });
  await page.mouse.move(knobPx.x, knobPx.y);
  await sleep(140);
  const cabinHintText = (await page.locator('[data-testid="cockpit-shifter-hint"]').innerText().catch(() => "")).replace(/\s+/g, " ");
  const cabinHintOk = cabinHintText.includes("3D-РЫЧАГ") && cabinHintText.includes("M1–M6") && cabinHintText.includes("D1–D6");
  // BTSI: без нажатого тормоза селектор не выходит из P (блокировка brake-transmission shift interlock)
  await page.mouse.down();
  // Клик — в pick-меш, перенос — на плоскости рукоятки с исходным offset захвата.
  // Проекция паза на пластине ниже рукоятки даёт другую траекторию из-за перспективы.
  const slotDPx = await dragPx("D");
  await page.mouse.move(slotDPx.x, slotDPx.y, { steps: 6 });
  await sleep(80);
  const gearNoBrake = (await page.evaluate(() => window.__cdtCockpit?.gear?.() ?? "")).trim();
  const interlockNotice = (await page.locator('[data-testid="notification"]').innerText().catch(() => "")) ||
    (await page.evaluate(() => document.body.innerText)).slice(0, 4000);
  // Удерживаем тормоз (S) и повторяем перетаскивание в D — теперь блокировка снимается
  await page.keyboard.down("KeyS");
  await page.mouse.move(slotDPx.x, slotDPx.y, { steps: 3 });
  await sleep(80);
  const afterDragD = (await hudDriveBtn.innerText()).trim();
  // Тормоз нужен только чтобы снять селектор с P; отпускаем S (удержание педали без газа
  // включает антизаглохание и возвращает M2→M1 на стоящем автомобиле), зато D1 разгоняется
  // самоходом на ХХ, поэтому шаг M1→M2 идёт на реально движущейся машине.
  await page.keyboard.up("KeyS");
  await sleep(900);
  // Тянем рычаг влево (к водителю) в ручной паз M, затем качаем вверх к + (M2)
  const slotMPx = await dragPx("M");
  const plusPx = await dragPx("M+");
  await page.mouse.move(slotMPx.x, slotMPx.y, { steps: 5 });
  await sleep(80);
  const afterDragM1 = (await hudDriveBtn.innerText()).trim();
  await page.mouse.move(plusPx.x, plusPx.y, { steps: 5 });
  await sleep(80);
  let afterDragM2 = (await hudDriveBtn.innerText()).trim();
  // Возвращаем рычаг в центр M и толкаем вправо обратно в автомат D
  await page.mouse.move(slotMPx.x, slotMPx.y, { steps: 4 });
  await page.mouse.move(slotDPx.x, slotDPx.y, { steps: 5 });
  await page.mouse.up();
  await sleep(100);
  const afterBackD = (await hudDriveBtn.innerText()).trim();
  // Возвращаем вид сзади (1)
  await page.keyboard.press("Digit1");
  await sleep(120);
  check("K7c подсказки КПП, BTSI-блокировка P без тормоза и рычаг в салоне P→D1→M1→M2→D",
    hudHintOk && cabinHintOk && gearNoBrake === "P" && /тормоз/i.test(interlockNotice) &&
      afterDragD === "D1" && afterDragM1 === "M1" && afterDragM2 === "M2" && /^D[12]$/.test(afterBackD),
    JSON.stringify({ shifterSettled, knobPick, topTag, hudHintOk, cabinHintOk, gearNoBrake, afterDragD, afterDragM1, afterDragM2, afterBackD }));

  // 3D-органы салона: 7" ШГУ, шайбы VOL/TUNE, аварийка, свет и ENGINE START/STOP доступны кликом
  // (координаты берём из отладочного моста __cdtCockpit — реальный raycast по 3D-мешам).
  // Возвращаемся в салон (после K7c вид сзади) и направляем взгляд на центральную консоль с 7" ШГУ
  await page.keyboard.press("Digit2");
  await sleep(260);
  await page.getByTestId("cockpit-look-headunit").click();
  const headSettled = await settleHead();
  await sleep(120);
  const controlPx = async (id) => {
    const p = await page.evaluate((cid) => window.__cdtCockpit?.controlPoint?.(cid) ?? null, id);
    return p ? toPx(p) : null;
  };
  const headPx = await controlPx("headunit");
  const volPx = await controlPx("vol");
  const tunePx = await controlPx("tune");
  const lightPx = await controlPx("headlight");
  const hazardPx = await controlPx("hazard");
  const controlsFound = Boolean(headPx && volPx && tunePx && lightPx && hazardPx);
  const headMode0 = await page.evaluate(() => window.__cdtCockpit?.headUnit?.().mode);
  let headHintOk = false;
  if (headPx) {
    await page.mouse.move(headPx.x, headPx.y);
    await sleep(160);
    const hint = await page.locator('[data-testid="cockpit-control-hint"]');
    headHintOk = (await hint.count()) === 1 &&
      (await hint.getAttribute("data-control")) === "headunit" &&
      /ШГУ/.test(await hint.innerText());
    await page.mouse.click(headPx.x, headPx.y);
    await until(() => page.evaluate((previous) => window.__cdtCockpit?.headUnit?.().mode !== previous, headMode0), 5000, 120);
  }
  const headMode1 = await page.evaluate(() => window.__cdtCockpit?.headUnit?.().mode);
  if (tunePx) { await page.mouse.click(tunePx.x, tunePx.y); await sleep(180); }
  const radioState = await page.evaluate(() => window.__cdtCockpit?.headUnit?.() ?? null);
  if (volPx) { await page.mouse.click(volPx.x, volPx.y); await sleep(180); }
  const radioPaused = await page.evaluate(() => window.__cdtCockpit?.headUnit?.()?.radioPlaying === false);
  if (hazardPx) { await page.mouse.click(hazardPx.x, hazardPx.y); await sleep(200); }
  const hazardOn = (await page.evaluate(() => window.__cdtCockpit?.signal?.() ?? "")) === "hazard";
  if (hazardPx) { await page.mouse.click(hazardPx.x, hazardPx.y); await sleep(200); }
  const lightsBefore = await page.evaluate(() => window.__cdtCockpit?.vehicle?.().lights === true);
  if (lightPx) { await page.mouse.click(lightPx.x, lightPx.y); await sleep(200); }
  const lightsAfter = await page.evaluate(() => window.__cdtCockpit?.vehicle?.().lights === true);
  const huStored = await page.evaluate(() => localStorage.getItem("cdt.headunit.v1"));
  // Звук ШГУ: сохранение трека «во время поездки» в кэш и воспроизведение из кэша.
  // В CI IndexedDB может быть ограничена, поэтому хранилище подменяется in-memory дублёром —
  // интерфейс `saveTrack/listTracks/loadTrack/deleteTrack/trackBackend` при этом тот же.
  await page.evaluate(() => {
    const db = new Map();
    const api = {
      async saveTrack(t) {
        db.set(t.key, { ...t, savedAt: new Date().toISOString(), size: t.blob.size });
        return true;
      },
      async listTracks() {
        return [...db.values()].map(({ blob, ...rest }) => rest);
      },
      async loadTrack(key) {
        return db.get(key) ?? null;
      },
      async deleteTrack(key) {
        db.delete(key);
      },
      async clearTracks() {
        db.clear();
      },
      trackBackend: () => "indexeddb",
    };
    window.__cdtAudioStore = api;
    window.__cdtAudioDb = db;
  });
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("button", { name: "Сбросить раскладку" }).click();
  await page.getByTestId("controls-headunit").scrollIntoViewIfNeeded();
  const soundBtn = page.getByTestId("sound-toggle");
  const soundOnAtStart = (await soundBtn.getAttribute("aria-pressed")) === "true";
  await soundBtn.click();
  await sleep(120);
  const soundOff = (await soundBtn.getAttribute("aria-pressed")) === "false";
  await soundBtn.click();
  await sleep(120);
  const soundOn = (await soundBtn.getAttribute("aria-pressed")) === "true";
  const audioBridgeOn = await page.evaluate(() => Boolean(window.__cdtCockpit?.audio));
  // Режим РАДИО: живой интернет-эфир реальной станции (в CI сети нет — плеер обязан не падать)
  await page.locator('[data-headunit-mode="radio"]').click();
  await sleep(300);
  const headRadio = await page.evaluate(() => window.__cdtCockpit?.headUnit?.() ?? null);
  const audioEl = await page.evaluate(() => window.__cdtCockpit?.audio?.()?.context ?? null);
  const streamRequested = Boolean(audioEl && /^https:\/\//.test(audioEl.src));
  // Сохраняем 32-секундный трек текущей станции в кэш прямо «в поездке»
  await page.getByTestId("headunit-save-track").click();
  await sleep(900);
  const savedAfterClick = await page.evaluate(() => window.__cdtAudioDb ? [...window.__cdtAudioDb.keys()] : []);
  const trackListText = (await page.getByTestId("headunit-tracklist").innerText().catch(() => "")).replace(/\s+/g, " ");
  const savedCountText = await page.evaluate(() => window.__cdtCockpit?.headUnit?.().savedCount ?? -1);
  // Слушаем трек из кэша: источник переключается на сохранённый трек
  await page.getByRole("button", { name: "Слушать кэш", exact: true }).click();
  await sleep(600);
  const savedSource = await page.evaluate(() => window.__cdtCockpit?.headUnit?.().source ?? "");
  const cachedAudio = await page.evaluate(() => window.__cdtCockpit?.audio?.()?.context?.src ?? "");
  const cachedIsBlob = cachedAudio.startsWith("blob:");
  check("K7e звук ШГУ: переключатель звука, живой интернет-эфир, сохранение трека в поездке и воспроизведение из кэша",
    soundOnAtStart && soundOff && soundOn && audioBridgeOn && headRadio?.mode === "radio" &&
      streamRequested && savedAfterClick.length === 1 && savedCountText === 1 &&
      /32 с/.test(trackListText) && savedSource === "saved" && cachedIsBlob,
    JSON.stringify({ soundOnAtStart, soundOff, soundOn, audioBridgeOn, radioMode: headRadio?.mode, streamRequested, savedAfterClick, savedCountText, trackListText, savedSource, cachedIsBlob }));
  // Возвращаем ШГУ в исходный режим «ассистент», чтобы K7d проверял цикл assist → radio с чистого состояния
  await page.locator('[data-headunit-mode="assist"]').click();
  await sleep(160);
  const modeReset = await page.evaluate(() => window.__cdtCockpit?.headUnit?.().mode === "assist");
  check("K7e2 ШГУ возвращается в исходный режим после проверки звука", modeReset);
  await page.getByRole("button", { name: "Закрыть настройки управления" }).click();
  await sleep(150);

  check("K7d 3D-органы салона: ШГУ переключает режимы, TUNE/VOL — станция и пауза, аварийка и свет работают",
    controlsFound && headHintOk && headMode0 === "assist" && headMode1 === "radio" &&
      radioState?.mode === "radio" && radioState?.radioPlaying === true && radioPaused &&
      hazardOn && lightsAfter !== lightsBefore && /"mode":"radio"/.test(huStored || ""),
    JSON.stringify({ headSettled, controlsFound, headHintOk, headMode0, headMode1, radioState, radioPaused, hazardOn, lightsBefore, lightsAfter }));

  // K9: взгляд водителя тремя детентами (левое зеркало → дорога → правое) и сигнал клаксона.
  // Инерция шеи считается по реальному времени кадра, но headless-рендер медленный,
  // поэтому довод ждём опросом, а не фиксированным sleep.
  await page.keyboard.press("Digit2");
  await sleep(260);
  const lookNow = () => page.evaluate(() => window.__cdtCockpit?.look?.() ?? { detent: 99, yawDeg: 0 });
  // Начинаем с явного «дорога»: предыдущие проверки могли оставить взгляд на ШГУ
  await page.getByTestId("head-detent-road").click();
  await until(async () => Math.abs((await lookNow()).yawDeg) < 6, 12000);
  const roadState = await lookNow();
  await page.getByTestId("head-detent-left").click();
  await until(async () => (await lookNow()).yawDeg > 30, 12000);
  const leftState = await lookNow();
  await page.getByTestId("head-detent-right").click();
  await until(async () => (await lookNow()).yawDeg < -30, 12000);
  const rightState = await lookNow();
  await page.getByTestId("head-detent-road").click();
  await until(async () => Math.abs((await lookNow()).yawDeg) < 6, 12000);
  const backState = await lookNow();
  // Клавиша H — клаксон: в кадре состояния появляется horn, после отпускания снимается
  await page.keyboard.down("h");
  const hornOn = await until(
    async () => (await page.evaluate(() => window.__cdtCockpit?.state?.()?.horn === true)) === true,
    6000,
    50
  );
  await page.keyboard.up("h");
  const hornOff = await until(
    async () => (await page.evaluate(() => window.__cdtCockpit?.state?.()?.horn === false)) === true,
    6000,
    50
  );
  check("K9 взгляд тремя детентами (левое зеркало → дорога → правое) и сигнал H на руле",
    roadState.detent === 0 && Math.abs(roadState.yawDeg) < 6 && leftState.yawDeg > 30 &&
      rightState.yawDeg < -30 && rightState.detent === -1 && Math.abs(backState.yawDeg) < 6 &&
      hornOn === true && hornOff === true,
    JSON.stringify({ roadState, leftState, rightState, backState, hornOn, hornOff }));

  check("K8 ошибок в консоли нет", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check("K   сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
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
  await page.keyboard.press("KeyU"); await sleep(200);
  check("L4 U сохраняет выбор зеркал, не создавая пустые отражения",await rear.count()===0 && await sideL.count()===1 && await sideR.count()===1);
  await page.keyboard.press("KeyU"); await sleep(200);
  await page.getByRole("button", { name: "Заднее", exact:true }).click();

  await page.getByRole("button", { name: "Быстрый старт" }).click();
  const controls=page.getByRole("button", { name:"Управление", exact:true });
  const slider=page.getByRole("slider", { name:"Максимальный угол поворота внутреннего колеса", exact:true });
  // Панель приборов может перекрывать панель «Управление» — закрываем её на время настройки выворота
  const clusterClose = page.getByRole("button", { name: "Закрыть: Приборы и КПП", exact: true });
  if (await clusterClose.count()) { await clusterClose.click(); await sleep(160); }
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
  // Возвращаем панель приборов: её показания скорости читает speedOf в L8
  await page.getByTestId("hud-restore-dock").click();
  await page.getByTestId("hud-panels-menu").getByRole("button", { name: "Показать все", exact: true }).click();
  await sleep(220);

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
  check("L сценарий выполнен без исключений",false,String(e.stack || e.message).slice(0, 5000));
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
  check("M сценарий выполнен без исключений",false,String(e.stack || e.message).slice(0, 5000));
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
  check("N сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
}

// ───────── O. Редактор карт: импорт .osm XML, размещение и перенос знаков/объектов, открытие в 3D ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);
  await tab(page, "Свой сценарий");
  await sleep(400);

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
  check("O сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
}

// ───────── P. Проверка маршрута OSM, неквадратные и произвольные границы, обрезка и фиксы редактора ─────────
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, httpUrl);

  // Вытянутый неквадратный участок OSM (сшивка 2 сегментов главной улицы + далёкая побочная улица + здание)
  const routeOsmXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="OpenStreetMap server">
  <bounds minlat="55.7495" minlon="37.6060" maxlat="55.7518" maxlon="37.6145"/>
  <node id="1" lat="55.7500" lon="37.6065"/>
  <node id="2" lat="55.7500" lon="37.6105"><tag k="highway" v="traffic_signals"/></node>
  <node id="3" lat="55.7500" lon="37.6142"><tag k="highway" v="crossing"/></node>
  <node id="4" lat="55.7516" lon="37.6070"/>
  <node id="5" lat="55.7516" lon="37.6095"/>
  <node id="10" lat="55.7514" lon="37.6120"/>
  <node id="11" lat="55.7514" lon="37.6124"/>
  <node id="12" lat="55.7517" lon="37.6124"/>
  <node id="13" lat="55.7517" lon="37.6120"/>
  <way id="101">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="пр-т Экзаменационный"/>
    <tag k="maxspeed" v="50"/>
  </way>
  <way id="102">
    <nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="пр-т Экзаменационный"/>
    <tag k="maxspeed" v="40"/>
  </way>
  <way id="103">
    <nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="ул. Внешняя"/>
  </way>
  <way id="104">
    <nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="13"/><nd ref="10"/>
    <tag k="building" v="yes"/>
  </way>
</osm>`;

  // 1. Загрузка OSM прямо в 3D-тренажёре -> видна панель проверки маршрута -> переход в редактор
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "exam-corridor.osm",
    mimeType: "application/xml",
    buffer: Buffer.from(routeOsmXml),
  });
  await sleep(600);
  const simBar = (await page.getByTestId("sim-osm-route-bar").innerText()).toLowerCase();
  check("P1 после загрузки OSM в 3D-тренажёре активна панель проверки маршрута и неквадратный размер",
    simBar.includes("маршрут:") && simBar.includes("кт") && !simBar.includes("240×240"),
    simBar.slice(0, 140));

  await page.getByTestId("sim-osm-open-editor").click();
  await sleep(500);

  // 2. В редакторе автоматически открыта панель «Проверка маршрута» + отрисованы сегменты по улице + размер неквадратный
  const checkSummary = await page.getByTestId("route-check-summary").innerText();
  const legsCount = await page.locator('[data-testid^="map-route-leg-"]').count();
  const dimText = await page.getByTestId("map-dimensions-badge").innerText();
  const dimMatch = dimText.match(/(\d+)×(\d+)\s*м/);
  const isNonSquare = Boolean(dimMatch && Number(dimMatch[1]) > Number(dimMatch[2]) * 1.6);
  check("P2 панель проверки маршрута в редакторе подтверждает маршрут и строит нитку по улицам",
    checkSummary.includes("Маршрут исправен") && legsCount >= 4 && isNonSquare,
    `${checkSummary} | legs=${legsCount} | ${dimText}`);

  // 3. Реверс направления маршрута перестраивает КТ и сохраняет валидность
  await page.getByTestId("editor-route-reverse-toggle").check();
  await page.getByTestId("editor-build-route-btn").click();
  await sleep(300);
  const revStatus = (await page.getByTestId("route-check-status").innerText()).toLowerCase();
  check("P3 реверс и перестроение маршрута по улице OSM проходят проверку",
    revStatus.includes("маршрут проверен"), revStatus);

  // 4. Построение неквадратного коридора маршрута и обрезка внешней улицы/здания
  await page.getByTestId("editor-tool-boundary").click();
  await sleep(150);
  await page.getByTestId("editor-corridor-btn").click();
  await sleep(250);
  const polyExists = (await page.locator('[data-testid="map-boundary-polygon"]').count()) === 1;
  await page.getByTestId("editor-crop-btn").click();
  await sleep(300);
  const croppedBody = await page.evaluate(() => document.body.innerText);
  check("P4 коридор маршрута создаёт полигон и обрезает внешнюю улицу и здание",
    polyExists && croppedBody.includes("Дороги (2)") && !croppedBody.includes("ул. Внешняя"),
    `poly=${polyExists}`);

  // 5. Восстановление всей выгрузки OSM и рисование произвольного 4-угольного контура от руки на холсте
  await page.getByTestId("editor-restore-osm-btn").click();
  await sleep(300);
  const restoredOk = (await page.evaluate(() => document.body.innerText)).includes("ул. Внешняя");
  await page.getByTestId("editor-tool-boundary").click();
  const canvas = page.getByTestId("map-editor-canvas");
  await canvas.scrollIntoViewIfNeeded();
  await sleep(150);
  const box = await canvas.boundingBox();
  for (const [rx, ry] of [[0.14, 0.56], [0.86, 0.56], [0.82, 0.86], [0.18, 0.86]]) {
    await canvas.click({ position: { x: Math.round(box.width * rx), y: Math.round(box.height * ry) } });
    await sleep(80);
  }
  const finishBtn = page.getByTestId("boundary-finish-btn");
  await finishBtn.scrollIntoViewIfNeeded();
  await finishBtn.click();
  await sleep(250);
  const vtxCount = await page.locator('[data-testid^="map-boundary-vertex-"]').count();
  check("P5 восстановление выгрузки OSM и рисование произвольного контура от руки (4 вершины)",
    restoredOk && vtxCount === 4, `restored=${restoredOk}, vertices=${vtxCount}`);

  // 6. Сброс к прямоугольнику + ввод отрицательной координаты в NumField + автопочинка маршрута
  await page.getByTestId("editor-tool-boundary").click();
  await sleep(150);
  const resetPolyBtn = page.getByTestId("editor-reset-boundary-btn");
  await resetPolyBtn.scrollIntoViewIfNeeded();
  await resetPolyBtn.click();
  await sleep(150);
  await page.getByTestId("editor-tool-select").click();
  const startMarker = page.getByTestId("map-start");
  await startMarker.scrollIntoViewIfNeeded();
  await startMarker.click({ force: true });
  await sleep(150);
  const startXInput = page.getByTestId("editor-inspector").locator('input[type="number"]').first();
  await startXInput.scrollIntoViewIfNeeded();
  await startXInput.fill("-999");
  await startXInput.press("Enter");
  await sleep(200);
  const brokenStatus = (await page.getByTestId("route-check-status").innerText()).toLowerCase();
  const fixBtn = page.getByTestId("editor-autofix-route-btn");
  await fixBtn.scrollIntoViewIfNeeded();
  await fixBtn.click();
  await sleep(250);
  const repairedStatus = (await page.getByTestId("route-check-status").innerText()).toLowerCase();
  check("P6 ввод отрицательного числа фиксирует выход старта, а «Исправить маршрут» чинит его",
    brokenStatus.includes("ошибок") && !repairedStatus.includes("ошибок"),
    `${brokenStatus} -> ${repairedStatus}`);

  // 7. Проверка сетки редактора (Выкл / 0,5 м / 2 м / 5 м) и Г-образной площадки с 3D-бордюром в тренажёре
  const lotTplBtn = page.getByRole("button", { name: "Площадка", exact: true });
  await lotTplBtn.scrollIntoViewIfNeeded();
  await lotTplBtn.click();
  await sleep(250);
  await page.getByTestId("editor-grid-0").click();
  await sleep(100);
  const gridOff = (await page.locator('[data-testid="map-grid"]').count()) === 0
    && (await page.getByTestId("map-dimensions-badge").innerText()).includes("сетка выкл");
  await page.getByTestId("editor-grid-2").click();
  await sleep(100);
  const step2 = await page.getByTestId("map-grid").getAttribute("data-grid-step");
  const lines2 = await page.locator('[data-testid="map-grid"] line').count();
  await page.getByTestId("editor-grid-0.5").click();
  await sleep(100);
  const step05 = await page.getByTestId("map-grid").getAttribute("data-grid-step");
  const lines05 = await page.locator('[data-testid="map-grid"] line').count();
  check("P7 сетка редактора реально отключается и меняет шаг линий (Выкл / 2 м / 0,5 м)",
    gridOff && step2 === "2" && step05 === "0.5" && lines05 > lines2 * 2,
    `off=${gridOff}, step2=${step2}(${lines2}), step05=${step05}(${lines05})`);

  await page.getByTestId("editor-tool-boundary").click();
  await page.getByTestId("editor-shape-l_shape").click();
  await page.getByTestId("editor-perimeter-curb-toggle").check();
  await sleep(200);
  const hasLPoly = (await page.locator('[data-testid="map-boundary-polygon"]').count()) === 1;
  const noRectLot = (await page.locator('[data-testid="map-lot-rect"]').count()) === 0;
  const lVtx = await page.locator('[data-testid^="map-boundary-vertex-"]').count();
  await page.getByRole("button", { name: /Открыть в тренажёре/ }).click();
  await sleep(900);
  check("P8 Г-образная асфальтовая площадка (без квадратного rect) с 3D-бордюром открывается в 3D без ошибок",
    hasLPoly && noRectLot && lVtx === 6 && errors.length === 0,
    `poly=${hasLPoly}, noRect=${noRectLot}, vtx=${lVtx}, err=${errors.slice(0, 2).join(" | ")}`);

  // 9. Бесконфликтный импорт реального .osm (oneway, забор с воротами поперёк улицы, дерево на оси, building=roof, слияние WGS84)
  await tab(page, "Свой сценарий");
  await sleep(300);
  const realConflictOsm = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <bounds minlat="55.7492" minlon="37.6095" maxlat="55.7518" maxlon="37.6122"/>
  <node id="1" lat="55.7494" lon="37.6105"/>
  <node id="2" lat="55.7501" lon="37.6105"><tag k="natural" v="tree"/></node>
  <node id="3" lat="55.7508" lon="37.6105"><tag k="barrier" v="gate"/></node>
  <node id="4" lat="55.7516" lon="37.6105"/>
  <node id="5" lat="55.7508" lon="37.6098"/>
  <node id="6" lat="55.7508" lon="37.6112"/>
  <node id="7" lat="55.7498" lon="37.6103"/><node id="8" lat="55.7498" lon="37.6107"/>
  <node id="9" lat="55.7500" lon="37.6107"/><node id="10" lat="55.7500" lon="37.6103"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><tag k="highway" v="primary"/><tag k="name" v="ул. Односторонняя"/><tag k="oneway" v="yes"/><tag k="lanes" v="2"/><tag k="maxspeed" v="RU:urban"/></way>
  <way id="11"><nd ref="5"/><nd ref="3"/><nd ref="6"/><tag k="barrier" v="fence"/></way>
  <way id="12"><nd ref="7"/><nd ref="8"/><nd ref="9"/><nd ref="10"/><nd ref="7"/><tag k="building" v="roof"/></way>
</osm>`;
  await page.getByTestId("editor-import-input").setInputFiles({
    name: "real-conflict.osm",
    mimeType: "application/xml",
    buffer: Buffer.from(realConflictOsm),
  });
  await sleep(450);
  const deconfNotes = (await page.getByTestId("editor-osm-deconflict-notes").innerText()).toLowerCase();
  const deconfRouteOk = (await page.getByTestId("route-check-status").innerText()).toLowerCase().includes("маршрут проверен");
  // Попытка реверса на односторонней улице OSM оставляет маршрут по разрешённому направлению и сбрасывает галку
  await page.getByTestId("editor-route-reverse-toggle").check();
  await page.getByTestId("editor-build-route-btn").click();
  await sleep(200);
  const revBlockedUnchecked = !(await page.getByTestId("editor-route-reverse-toggle").isChecked());
  // Кнопка согласования + режим сохранения пользовательских объектов при повторном импорте расширенного bbox
  await page.getByTestId("editor-deconflict-btn").click();
  await page.getByTestId("editor-import-preserve-toggle").check();
  await page.getByTestId("editor-import-input").setInputFiles({
    name: "real-conflict-expanded.osm",
    mimeType: "application/xml",
    buffer: Buffer.from(realConflictOsm.replace('maxlon="37.6122"', 'maxlon="37.6134"')),
  });
  await sleep(350);
  await page.getByRole("button", { name: /Открыть в тренажёре/ }).click();
  await sleep(800);
  check("P9 бесконфликтный импорт .osm: отчёт WGS84/согласования, защита oneway от реверса и 3D без ошибок",
    deconfNotes.includes("wgs84") && deconfNotes.includes("односторонних: 1") && deconfNotes.includes("согласовано:")
      && deconfRouteOk && revBlockedUnchecked && errors.length === 0,
    `notes=${deconfNotes.slice(0, 110)} | ok=${deconfRouteOk} | owBlock=${revBlockedUnchecked} | err=${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
} catch (e) {
  check("P сценарий выполнен без исключений", false, String(e.stack || e.message).slice(0, 5000));
}

await browser.close();
console.log(failed === 0 ? "SMOKE: все проверки пройдены" : `SMOKE: не пройдено ${failed}`);
process.exit(failed === 0 ? 0 : 1);
