#!/usr/bin/env node
// Автономный CI-раннер модульных и интеграционных тестов чистого ядра CityDrivingTraining.
// Запуск: node scripts/run-tests.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outFile = join(tmpdir(), `cdt-selftest-${process.pid}.mjs`);
const esbuildBin = resolve(
  root,
  process.platform === "win32" ? "node_modules/.bin/esbuild.cmd" : "node_modules/.bin/esbuild"
);

// 1. Проверка архитектурных границ: чистое ядро не импортирует three и не трогает DOM
const PURE_DIRS = ["src/sim", "src/scoring", "src/maps", "src/scenarios", "src/stats"];
const FORBIDDEN = /(?:from\s+["']three["']|\bwindow\.|\bdocument\.)/;

function walkTs(dir) {
  const res = [];
  if (!existsSync(dir)) return res;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) res.push(...walkTs(full));
    else if (full.endsWith(".ts")) res.push(full);
  }
  return res;
}

for (const d of PURE_DIRS) {
  for (const file of walkTs(resolve(root, d))) {
    const src = readFileSync(file, "utf8");
    if (FORBIDDEN.test(src)) {
      console.error(`ARCHITECTURE FAIL: запрещённая зависимость three/DOM в ${file}`);
      process.exit(1);
    }
  }
}
console.log("GATE 1/2 · Архитектурные границы чистого ядра: OK (0 three/DOM)");

// 2. Сборка и прогон всех автотестов в чистом Node.js
execFileSync(
  esbuildBin,
  ["src/sim/selfTest.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${outFile}`],
  { stdio: "pipe" }
);

try {
  const { runAllSelfTests } = await import(pathToFileURL(outFile).href);
  const results = runAllSelfTests();
  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(`${mark} ${r.id} [${r.suite}] ${r.name}\n     ${r.detail}`);
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.error(`\nПРОВАЛЕНО ТЕСТОВ: ${failed.length} из ${results.length}`);
    process.exit(1);
  }
  console.log(`\nGATE 2/2 · Автотесты ядра: ${results.length}/${results.length} OK`);
} finally {
  if (existsSync(outFile)) unlinkSync(outFile);
}
