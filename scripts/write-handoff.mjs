/**
 * Записывает HANDOFF.md из src/handoff.ts — единственного источника правды.
 * Так документ в репозитории и текст, который копируется из интерфейса, не расходятся.
 *
 *   node scripts/write-handoff.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const esbuild = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild"
);
const dir = mkdtempSync(join(tmpdir(), "cdt-handoff-"));
const bundle = join(dir, "handoff.mjs");

try {
  execFileSync(
    esbuild,
    ["src/handoff.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"],
    { stdio: "inherit" }
  );
  const { HANDOFF_FILE } = await import(pathToFileURL(bundle).href);
  if (typeof HANDOFF_FILE !== "string" || HANDOFF_FILE.length < 500) {
    throw new Error("src/handoff.ts не отдал документ — проверь экспорт HANDOFF_MARKDOWN");
  }
  writeFileSync("HANDOFF.md", HANDOFF_FILE, "utf8");
  const lines = HANDOFF_FILE.split("\n").length;
  console.log(`HANDOFF.md записан: ${HANDOFF_FILE.length} символов, ${lines} строк`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
