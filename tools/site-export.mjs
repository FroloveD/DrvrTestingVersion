#!/usr/bin/env node
/**
 * @module tools/site-export.mjs
 * @layer tools
 * @role Автономная выгрузка публичной HTML-страницы (Tilda и подобных конструкторов) в локальный архив:
 *       HTML + CSS + JS + изображения + шрифты, со ссылками, переписанными на относительные пути.
 * @invariants
 *   - Только HTTP GET публичных ресурсов; на сайт ничего не отправляется.
 *   - Порядок `<style>`/`<link>` в документе не меняется — каскад CSS сохраняется байт-в-байт.
 *   - Исходный HTML сохраняется без правок в `index.original.html`.
 *   - Детерминированные имена файлов: одинаковый URL всегда даёт один и тот же путь.
 * @usage
 *   node tools/site-export.mjs <url> <outDir> [--max-file-mb=20] [--max-total-mb=200] [--keep-trackers]
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Хосты, любые ссылки с которых считаем ресурсами страницы (CDN конструктора, шрифты).
const ASSET_HOST_SUFFIXES = [
  "tildacdn.com",
  "tildacdn.pub",
  "tildacdn.info",
  "googleapis.com",
  "gstatic.com",
  "jsdelivr.net",
  "unpkg.com",
];

const ASSET_EXTS = new Set([
  ".css", ".js", ".mjs", ".json", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".ogg", ".mp3", ".m4a", ".wav", ".pdf", ".vtt", ".xml",
]);

// Аналитика и трекеры: при желании удаляются из копии (исходник остаётся нетронутым).
const TRACKER_PATTERNS = [
  /mc\.yandex\.ru/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /connect\.facebook\.net/i,
  /top-fwz1\.mail\.ru/i,
  /vk\.com\/rtrg/i,
  /yadro\.ru/i,
];

const CONCURRENCY = 8;

// ─────────────────────────── CLI ───────────────────────────

const args = process.argv.slice(2);
const flags = new Map(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    })
);
const positional = args.filter((a) => !a.startsWith("--"));
const startUrl = positional[0];
const outDir = positional[1] || "site-export";
if (!startUrl) {
  console.error("Использование: node tools/site-export.mjs <url> <outDir> [--max-file-mb=20] [--max-total-mb=200] [--keep-trackers]");
  process.exit(2);
}
const maxFileBytes = Number(flags.get("max-file-mb") ?? 20) * 1024 * 1024;
const maxTotalBytes = Number(flags.get("max-total-mb") ?? 200) * 1024 * 1024;
const keepTrackers = flags.has("keep-trackers");

// ─────────────────────────── Загрузчик ───────────────────────────

/** @type {Map<string, {url: string, finalUrl: string, buf: Buffer, ct: string}>} */
const files = new Map();
const scheduled = new Set();
const queue = [];
const failures = [];
let totalBytes = 0;
let startedAt = "";

function enqueue(url) {
  if (scheduled.has(url)) return;
  scheduled.add(url);
  queue.push(url);
}

function isCss(url, ct = "") {
  return ct === "text/css" || new URL(url).pathname.toLowerCase().endsWith(".css");
}

function isHtml(url, ct = "") {
  return ct === "text/html" || ct === "application/xhtml+xml";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTracker(url) {
  return TRACKER_PATTERNS.some((re) => re.test(url));
}

function isAsset(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (isTracker(url) && !keepTrackers) return false;
  const host = u.hostname.toLowerCase();
  if (ASSET_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) return true;
  const ext = path.posix.extname(u.pathname).toLowerCase();
  return ASSET_EXTS.has(ext);
}

async function fetchOne(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxFileBytes) throw new Error(`файл больше ${(maxFileBytes / 1048576).toFixed(0)} МБ (${declared} байт)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxFileBytes) throw new Error(`файл больше ${(maxFileBytes / 1048576).toFixed(0)} МБ (${buf.length} байт)`);
    if (totalBytes + buf.length > maxTotalBytes) {
      throw new Error(`превышен общий лимит ${(maxTotalBytes / 1048576).toFixed(0)} МБ`);
    }
    totalBytes += buf.length;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const record = { url, finalUrl: res.url || url, buf, ct };
    files.set(url, record);
    if (record.finalUrl !== url) files.set(record.finalUrl, record);
    // Рекурсия по CSS: url(...) и @import внутри скачанного стиля.
    if (isCss(record.finalUrl, ct)) {
      for (const ref of collectCssRefs(buf.toString("utf8"), record.finalUrl)) enqueue(ref);
    }
    return record;
  } catch (err) {
    failures.push({ url, error: String(err && err.message ? err.message : err) });
    return null;
  }
}

async function drainQueue() {
  await new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      if (active === 0 && queue.length === 0) return resolve();
      while (active < CONCURRENCY && queue.length > 0) {
        const url = queue.shift();
        active += 1;
        fetchOne(url).finally(() => {
          active -= 1;
          pump();
        });
      }
    };
    pump();
  });
}

// ─────────────────────────── Разбор ссылок ───────────────────────────

function collectCssRefs(css, baseUrl) {
  const out = [];
  const push = (raw) => {
    if (!raw) return;
    const s = raw.trim().replace(/^["']|["']$/g, "");
    if (!s || /^(data:|blob:|#)/i.test(s)) return;
    try {
      const abs = new URL(s, baseUrl).href;
      if (isAsset(abs)) out.push(abs);
    } catch {
      /* некорректная ссылка — пропускаем */
    }
  };
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi)) push(m[1] ?? m[2] ?? m[3]);
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) push(m[1]);
  return out;
}

function collectHtmlAssets(html, pageUrl) {
  const found = new Set();
  const push = (raw) => {
    if (!raw) return;
    const s = raw.trim().replace(/&amp;/g, "&");
    if (!s || /^(data:|mailto:|tel:|javascript:|blob:|#)/i.test(s)) return;
    let abs;
    try {
      abs = new URL(s, pageUrl).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs)) return;
    if (isAsset(abs)) found.add(abs);
  };

  for (const m of html.matchAll(
    /\b(?:src|href|data-original|data-src|data-bg|data-background|data-lazy|poster|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  )) {
    push(m[1] ?? m[2] ?? m[3]);
  }
  for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const part of (m[1] ?? m[2]).split(",")) push(part.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/(?:https?:)?\/\/[^\s"'()<>\\]+/gi)) push(m[0]);
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi)) push(m[1] ?? m[2] ?? m[3]);
  return found;
}

// ─────────────────────────── Имена файлов ───────────────────────────

const usedPaths = new Set();

function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function extFromContentType(ct) {
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "application/json": ".json",
  };
  return map[ct] || "";
}

function kindDir(ext, ct) {
  if (ext === ".css") return "css";
  if ([".js", ".mjs"].includes(ext)) return "js";
  if ([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico", ".bmp"].includes(ext)) return "img";
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "fonts";
  if ([".mp4", ".webm", ".ogg", ".mp3", ".m4a", ".wav", ".vtt"].includes(ext)) return "media";
  if (ext === ".json" || ext === ".xml") return "data";
  if (ext === ".pdf") return "docs";
  if ((ct || "").startsWith("image/")) return "img";
  return "other";
}

function assignPath(record) {
  const u = new URL(record.finalUrl);
  let base = decodeURIComponent(path.posix.basename(u.pathname));
  base = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base || base === ".") base = "index";
  if (base.length > 90) {
    const ext = path.posix.extname(base);
    base = base.slice(0, 90 - ext.length) + ext;
  }
  let ext = path.posix.extname(base).toLowerCase();
  if (!ext) {
    ext = extFromContentType(record.ct) || ".bin";
    base += ext;
  }
  const dir = kindDir(ext, record.ct);
  let rel = `${dir}/${base}`;
  if (usedPaths.has(rel.toLowerCase())) rel = `${dir}/${shortHash(record.finalUrl)}-${base}`;
  usedPaths.add(rel.toLowerCase());
  return rel;
}

// ─────────────────────────── Основной сценарий ───────────────────────────

async function main() {
  startedAt = new Date().toISOString();
  console.log(`Экспорт ${startUrl} → ${outDir}`);

  const pageRes = await fetch(startUrl, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(60000),
  });
  if (!pageRes.ok) throw new Error(`страница вернула HTTP ${pageRes.status}`);
  const pageUrl = pageRes.url || startUrl;
  let html = await pageRes.text();
  const originalHtml = html;
  console.log(`HTML получен: ${(Buffer.byteLength(html) / 1024).toFixed(1)} КБ, финальный адрес ${pageUrl}`);

  // 1. Трекеры — до сбора ссылок, чтобы их скрипты не скачивались.
  if (!keepTrackers) {
    let removed = 0;
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script>/gi, (tag) => {
      if (TRACKER_PATTERNS.some((re) => re.test(tag))) {
        removed += 1;
        return `<!-- tracker script removed: ${shortHash(tag)} -->`;
      }
      return tag;
    });
    html = html.replace(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>/gi, (tag) => {
      if (TRACKER_PATTERNS.some((re) => re.test(tag))) {
        removed += 1;
        return `<!-- tracker pixel removed -->`;
      }
      return tag;
    });
    console.log(`Удалено трекеров: ${removed}`);
  }

  // 2. Сбор и загрузка всех ресурсов (CSS тянет шрифты и картинки рекурсивно).
  const pageAlso = [pageUrl, startUrl];
  for (const url of collectHtmlAssets(html, pageUrl)) enqueue(url);
  await drainQueue();

  // 3. Детерминированные локальные пути.
  const canonical = new Map(); // любой вариант URL → относительный путь
  const byRecord = new Map();
  for (const record of new Set(files.values())) {
    const rel = assignPath(record);
    byRecord.set(record, rel);
    canonical.set(record.url, rel);
    canonical.set(record.finalUrl, rel);
  }
  console.log(`Скачано файлов: ${byRecord.size}, суммарно ${(totalBytes / 1048576).toFixed(2)} МБ, ошибок ${failures.length}`);

  // 4. Перезапись ссылок внутри CSS на относительные.
  const cssOut = new Map();
  const rewriteCssText = (text, baseUrl, fromRel) => {
    const toLocal = (raw) => {
      const s = String(raw).trim().replace(/^["']|["']$/g, "");
      if (!s || /^(data:|blob:|#)/i.test(s)) return null;
      let abs;
      try {
        abs = new URL(s, baseUrl).href;
      } catch {
        return null;
      }
      const target = canonical.get(abs);
      return target ? path.posix.relative(path.posix.dirname(fromRel || "css/x.css"), target) : null;
    };
    let out = text
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi, (all, d, s, p) => {
        const local = toLocal(d ?? s ?? p);
        return local ? `url("${local}")` : all;
      })
      .replace(/(@import\s+(?:url\(\s*)?)(["'])([^"']+)\2/gi, (all, pre, quote, raw) => {
        const local = toLocal(raw);
        return local ? `${pre}${quote}${local}${quote}` : all;
      });
    return out;
  };
  for (const [record, rel] of byRecord) {
    if (!isCss(record.finalUrl, record.ct)) continue;
    cssOut.set(rel, rewriteCssText(record.buf.toString("utf8"), record.finalUrl, rel));
  }

  // 5. Перезапись ссылок в HTML (длинные URL первыми, чтобы не портить вложенные).
  //    Варианты нужны и без схемы: Tilda часто пишет //static.tildacdn.com/... — такие
  //    протокол-относительные ссылки внутри <style> тоже должны стать локальными.
  const rewrite = (text) => {
    const ordered = [...canonical.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [abs, rel] of ordered) {
      const bare = abs.replace(/^https?:/, "");
      const variants = new Set([
        abs,
        abs.replace(/&/g, "&amp;"),
        abs.replace(/'/g, "&#39;"),
        abs.replace(/"/g, "&quot;"),
        bare,
        bare.replace(/&/g, "&amp;"),
      ]);
      for (const variant of variants) if (variant) text = text.split(variant).join(rel);
    }
    return text;
  };
  let indexHtml = rewrite(html);
  // Ссылки на саму страницу (в т.ч. с якорями) ведут на локальный index.html.
  for (const self of new Set(pageAlso.concat(pageAlso.map((u) => u.replace(/\/$/, ""))))) {
    indexHtml = indexHtml.split(self + "/#").join("index.html#");
    indexHtml = indexHtml.split(self + "#").join("index.html#");
    indexHtml = indexHtml.split(self + "\"").join("index.html\"");
    indexHtml = indexHtml.split(self + "'").join("index.html'");
  }
  // Удалённые трекеры больше не должны «бить» в никуда.
  if (!keepTrackers) {
    indexHtml = indexHtml.replace(/<!-- tracker[^>]*-->/g, "");
  }

  // 6. Версия с вынесенным CSS: каждый <style> → отдельный файл css/inline-NN.css.
  //    Внутри блока ссылки пересчитываются от корня страницы к каталогу css/.
  const inlineBlocks = [];
  const splitHtml = indexHtml.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_all, _attrs, css) => {
    const name = `inline-${String(inlineBlocks.length + 1).padStart(2, "0")}.css`;
    inlineBlocks.push({ name, css: rewriteCssText(css, pageUrl, `css/${name}`) });
    return `<link rel="stylesheet" href="css/${name}">`;
  });

  // 7. Запись файлов.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const [record, rel] of byRecord) {
    const full = path.join(outDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, cssOut.has(rel) ? cssOut.get(rel) : record.buf);
  }
  await mkdir(path.join(outDir, "css"), { recursive: true });
  for (const block of inlineBlocks) {
    await writeFile(path.join(outDir, "css", block.name), `/* Извлечено из <style> #${block.name.match(/\d+/)[0]} документа */\n${block.css}`);
  }
  await writeFile(path.join(outDir, "index.html"), indexHtml);
  await writeFile(path.join(outDir, "index.split-css.html"), splitHtml);
  await writeFile(path.join(outDir, "index.original.html"), originalHtml);

  // 8. Служебные файлы.
  const summary = {
    source: startUrl,
    finalUrl: pageUrl,
    exportedAt: startedAt,
    title: (originalHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "",
    htmlBytes: Buffer.byteLength(originalHtml),
    cssFiles: [...byRecord.values()].filter((r) => r.startsWith("css/")).length,
    inlineCssBlocks: inlineBlocks.length,
    downloadedFiles: byRecord.size,
    downloadedBytes: totalBytes,
    failures,
  };
  await writeFile(path.join(outDir, "meta.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(path.join(outDir, "README.md"), buildReadme(summary, byRecord));

  console.log(`Готово: ${outDir}`);
  console.log(`  index.html — локальная копия, CSS внутри`);
  console.log(`  index.split-css.html — CSS вынесен в css/inline-NN.css (${inlineBlocks.length} блоков)`);
  console.log(`  index.original.html — исходный HTML без правок`);
  if (failures.length) console.log(`  ошибок загрузки: ${failures.length} (см. meta.json)`);
}

function buildReadme(summary, byRecord) {
  const dirs = {};
  for (const rel of byRecord.values()) {
    const dir = rel.includes("/") ? rel.split("/")[0] : "root";
    dirs[dir] = (dirs[dir] || 0) + 1;
  }
  const dirList = Object.entries(dirs)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `- \`${d}/\` — ${n} файл(ов)`)
    .join("\n");
  return `# Офлайн-выгрузка сайта

- **Источник:** ${summary.finalUrl}
- **Заголовок:** ${summary.title || "—"}
- **Дата выгрузки:** ${summary.exportedAt}
- **Размер HTML:** ${(summary.htmlBytes / 1024).toFixed(1)} КБ
- **Файлов ресурсов:** ${summary.downloadedFiles} (${(summary.downloadedBytes / 1048576).toFixed(2)} МБ)

## Что внутри

| Файл | Назначение |
|---|---|
| \`index.html\` | Локальная копия страницы. Все ресурсы локальные, CSS — в исходном виде внутри документа (как у Tilda). |
| \`index.split-css.html\` | Та же страница, но каждый \`<style>\` вынесен в \`css/inline-NN.css\` и подключён через \`<link>\`. Удобно для правки стилей. |
| \`index.original.html\` | Исходный HTML, полученный с сайта, без единой правки. |
| \`css/\` | Внешние стили сайта + извлечённые блоки. |
| \`js/\` | Скрипты страницы. |
| \`img/\` | Изображения. |
| \`fonts/\` | Шрифты. |
| \`meta.json\` | Служебные данные и список ошибок загрузки. |

${dirList}

## Как открыть

Двойной клик по \`index.html\`. Если браузер ограничивает \`file://\` (некоторые скрипты Tilda), запустите локальный сервер:

\`\`\`bash
python3 -m http.server 8000
# затем http://localhost:8000/index.html
\`\`\`

## Что учесть

- Выгрузка — копия публичной страницы для личного/архивного использования. Права на контент и дизайн остаются у автора сайта.
- Формы, счётчики и серверные функции Tilda (отправка заявок, статистика, CMS-лента) в офлайне не работают — это статическая копия.
- Аналитические скрипты (Яндекс.Метрика, Google Analytics и т.п.) из копии удалены; в \`index.original.html\` они сохранены.
`;
}

main().catch((err) => {
  console.error("ОШИБКА:", err);
  process.exit(1);
});
