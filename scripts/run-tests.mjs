#!/usr/bin/env node
/**
 * Единый автономный гейт CityDrivingTraining для локальной разработки, ИИ-агентов и CI.
 *
 * Запуск:
 *   node scripts/run-tests.mjs                # границы ядра + автотесты + синхронность документации
 *   node scripts/run-tests.mjs --check-dist   # то же + обязательная проверка автономности dist/index.html
 *
 * Проверяет 4 контура:
 *   1. Чистота архитектуры: 7 каталогов ядра + src/handoff.ts не содержат three, window., document.
 *   2. Автотесты ядра: все кейсы runAllSelfTests() проходят в чистом Node.js.
 *   3. Документация как код:
 *      - HANDOFF.md побайтово совпадает с src/handoff.ts (HANDOFF_FILE);
 *      - присутствуют обязательные документы (README.md, AGENTS.md, HANDOFF.md, WORKLOG.md, NOTICE, docs/*);
 *      - все явные пути вида src/..., scripts/..., tests/..., tools/..., docs/... в HANDOFF.md существуют;
 *      - каждый .ts-модуль чистого ядра упомянут в HANDOFF.md (новый модуль нельзя забыть задокументировать).
 *   4. Автономность сборки (с флагом --check-dist или при наличии dist/index.html):
 *      - в dist/index.html нет внешних http(s):// ссылок в <script src=...> и <link href=...>.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const requireDist = process.argv.includes("--check-dist");
const esbuildBin = resolve(
  root,
  process.platform === "win32" ? "node_modules/.bin/esbuild.cmd" : "node_modules/.bin/esbuild"
);

const PURE_DIRS = [
  "src/sim",
  "src/scoring",
  "src/maps",
  "src/scenarios",
  "src/analytics",
  "src/storage",
  "src/strategy",
];
const FORBIDDEN = /(?:from\s+["']three(?:\/|["'])|\bwindow\.|\bdocument\.)/;

const REQUIRED_DOCS = [
  "README.md",
  "AGENTS.md",
  "HANDOFF.md",
  "WORKLOG.md",
  "NOTICE",
  "docs/ARCHITECTURE.md",
  "docs/ADR.md",
  "docs/BRANCH_AUDIT.md",
  "docs/CALIBRATION_GUIDE.md",
];

function walkTs(dir, includeTsx = false) {
  const res = [];
  if (!existsSync(dir)) return res;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) res.push(...walkTs(full, includeTsx));
    else if (full.endsWith(".ts") || (includeTsx && full.endsWith(".tsx"))) res.push(full);
  }
  return res;
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

// ───────── GATE 1: Архитектурные границы чистого ядра ─────────
const pureFiles = [];
for (const d of PURE_DIRS) {
  const abs = resolve(root, d);
  if (!existsSync(abs)) fail(`отсутствует каталог чистого ядра ${d}`);
  pureFiles.push(...walkTs(abs));
}
for (const file of pureFiles) {
  const src = readFileSync(file, "utf8");
  if (FORBIDDEN.test(src)) {
    fail(`запрещённая зависимость three/window/document в ${relative(root, file)}`);
  }
}
console.log(`GATE 1/4 · Чистое ядро (${PURE_DIRS.length} каталогов, ${pureFiles.length} файлов): OK (0 three/DOM)`);

const tmpDir = mkdtempSync(join(tmpdir(), "cdt-gate-"));
try {
  // ───────── GATE 2: Автотесты ядра в чистом Node.js ─────────
  const testBundle = join(tmpDir, "selftest.mjs");
  execFileSync(
    esbuildBin,
    ["src/sim/selfTest.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${testBundle}`, "--log-level=error"],
    { stdio: "inherit" }
  );
  const { runAllSelfTests } = await import(pathToFileURL(testBundle).href);
  const results = runAllSelfTests();
  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(`  ${mark} ${r.id} [${r.suite}] ${r.name}`);
    if (!r.passed) console.error(`       ${r.detail}`);
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    fail(`провалено автотестов: ${failed.length} из ${results.length}`);
  }
  console.log(`GATE 2/4 · Автотесты ядра: ${results.length}/${results.length} OK`);

  // Renderer geometry regression: actual projection/ray methods, no browser or WebGL context.
  const shifterBundle = join(tmpDir, "shifter-projection.mjs");
  execFileSync(esbuildBin,
    ["tests/shifter-projection.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${shifterBundle}`, "--log-level=error"],
    { stdio: "inherit" });
  await import(pathToFileURL(shifterBundle).href);

  // ───────── GATE 3: Документация как код ─────────
  for (const doc of REQUIRED_DOCS) {
    if (!existsSync(resolve(root, doc))) {
      fail(`отсутствует обязательный документ ${doc}`);
    }
  }

  const handoffBundle = join(tmpDir, "handoff.mjs");
  execFileSync(
    esbuildBin,
    ["src/handoff.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${handoffBundle}`, "--log-level=error"],
    { stdio: "inherit" }
  );
  const { HANDOFF_FILE } = await import(pathToFileURL(handoffBundle).href);
  const handoffDisk = readFileSync(resolve(root, "HANDOFF.md"), "utf8");
  if (handoffDisk !== HANDOFF_FILE) {
    fail("HANDOFF.md разошёлся с src/handoff.ts — выполните `node scripts/write-handoff.mjs`");
  }

  // Проверяем, что все явные пути к файлам в ключевых документах реально существуют
  const pathRegex = /`((?:src|scripts|tests|tools|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g;
  for (const doc of ["HANDOFF.md", "AGENTS.md", "README.md", "docs/ARCHITECTURE.md", "docs/ADR.md", "docs/CALIBRATION_GUIDE.md"]) {
    const text = readFileSync(resolve(root, doc), "utf8");
    for (const m of text.matchAll(pathRegex)) {
      const refPath = m[1];
      if (!existsSync(resolve(root, refPath))) {
        fail(`в ${doc} указан несуществующий путь \`${refPath}\``);
      }
    }
  }

  // Проверяем, что все секционные якоря [SEC:...], перечисленные в docs/ARCHITECTURE.md, существуют в коде
  const archText = readFileSync(resolve(root, "docs/ARCHITECTURE.md"), "utf8");
  const anchorFiles = [
    "src/components/SimulatorView.tsx",
    "src/render/sceneController.ts",
    "src/components/DebriefView.tsx",
    "src/components/CustomScenarioView.tsx",
  ]
    .map((p) => readFileSync(resolve(root, p), "utf8"))
    .join("\n");
  for (const m of archText.matchAll(/`(\[SEC:[a-z0-9-]+\])`/g)) {
    const anchor = m[1];
    if (!anchorFiles.includes(anchor)) {
      fail(`якорь ${anchor} из docs/ARCHITECTURE.md не найден в коде`);
    }
  }

  // Проверяем, что каждый .ts-модуль чистого ядра задокументирован в HANDOFF.md
  for (const d of PURE_DIRS) {
    for (const file of walkTs(resolve(root, d))) {
      const rel = relative(root, file).replace(/\\/g, "/");
      if (!handoffDisk.includes(`\`${rel}\``)) {
        fail(`модуль ядра \`${rel}\` не описан в карте модулей HANDOFF.md (обновите src/handoff.ts)`);
      }
    }
  }

  // Проверяем, что каждый .ts/.tsx-модуль в src/ имеет паспорт @module в шапке
  const allSrcFiles = walkTs(resolve(root, "src"), true);
  for (const file of allSrcFiles) {
    const head = readFileSync(file, "utf8").slice(0, 600);
    if (!head.includes("@module ")) {
      fail(`файл \`${relative(root, file).replace(/\\/g, "/")}\` не содержит паспорт @module в шапке`);
    }
  }

  // Проверяем, что заявленное в HANDOFF.md число автотестов совпадает с фактическим
  const countMatch = handoffDisk.match(/\|\s*Тесты ядра\s*\|\s*(\d+)\s+автотест/);
  if (!countMatch || Number(countMatch[1]) !== results.length) {
    fail(
      `число автотестов в HANDOFF.md (${countMatch ? countMatch[1] : "не найдено"}) != фактическому (${results.length})`
    );
  }
  console.log(
    `GATE 3/4 · Документация (${REQUIRED_DOCS.length} доков, ${allSrcFiles.length} @module, HANDOFF/пути/якоря/счётчики): OK`
  );

  // ───────── GATE 4: Автономность прод-бандла dist/index.html ─────────
  const distHtml = resolve(root, "dist/index.html");
  if (requireDist && !existsSync(distHtml)) {
    fail("флаг --check-dist требует собранный dist/index.html (сначала выполните `npm run build`)");
  }
  if (existsSync(distHtml)) {
    const html = readFileSync(distHtml, "utf8");
    // Проверяем реальные HTML-теги <script src="...">, <link href="...">, <img src="..."> и CSS @import/url()
    // (содержимое встроенных <script> без src очищаем, чтобы строковые примеры из архива src/data.ts не давали ложных срабатываний)
    const markupAndCss = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, "<script></script>");
    if (
      /<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//i.test(markupAndCss) ||
      /url\(\s*["']?https?:\/\//i.test(markupAndCss) ||
      /@import\s+["']https?:\/\//i.test(markupAndCss)
    ) {
      fail("в dist/index.html обнаружены внешние http(s):// ресурсы (HTML/CSS) — нарушен офлайн-инвариант #8");
    }
    const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
    console.log(`GATE 4/4 · Автономность dist/index.html (${sizeKb} КБ, 0 внешних HTML/CSS-ресурсов): OK`);
  } else {
    console.log("GATE 4/4 · dist/index.html не найден (пропущено; для обязательной проверки передайте --check-dist)");
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
