#!/usr/bin/env node
/**
 * @module tools/gh-artifact.mjs
 * @layer tools
 * @role Скачивание артефакта GitHub Actions без browser-загрузки и распаковка ZIP — для сред,
 *       где наружу доступен только `api.github.com` (egress-allowlist песочницы).
 * @invariants
 *   - Никаких сторонних зависимостей: Node 22 + встроенный `fetch`, `zlib`, `node:fs`.
 *   - Если сервер присылает JSON `{archive_download_url}`, скачивание идёт по подписанной ссылке.
 *   - Распаковка безопасна: путь каждого файла проверяется на выход за пределы каталога.
 * @usage
 *   node tools/gh-artifact.mjs <owner/repo> <runId|artifactName> <outDir>
 */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const api = "https://api.github.com";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "gh-artifact-downloader",
  "x-github-api-version": "2022-11-28",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const [repo, ref, outDir = "artifact"] = process.argv.slice(2);
if (!repo || !ref) {
  console.error("Использование: node tools/gh-artifact.mjs <owner/repo> <runId|artifactName> <outDir>");
  process.exit(2);
}

async function apiJson(url) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function findArtifact() {
  if (/^\d+$/.test(ref)) {
    const list = await apiJson(`${api}/repos/${repo}/actions/runs/${ref}/artifacts`);
    if (!list.artifacts.length) throw new Error(`у запуска ${ref} нет артефактов`);
    return list.artifacts[0];
  }
  const list = await apiJson(`${api}/repos/${repo}/actions/artifacts?per_page=100`);
  const found = list.artifacts.filter((a) => a.name === ref).sort((a, b) => b.id - a.id)[0];
  if (!found) throw new Error(`артефакт «${ref}» не найден (есть: ${list.artifacts.map((a) => a.name).join(", ") || "—"})`);
  return found;
}

async function download(url, dest) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`скачивание ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

// ─────────────────────────── Минимальный unzip ───────────────────────────

function unzip(buf, destDir) {
  const files = [];
  // Ищем End Of Central Directory.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP повреждён: не найден EOCD");
  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("ZIP повреждён: неверный central directory");
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const rel = path.normalize(name).replace(/^([./\\])+/, "");
    if (rel.startsWith("..")) throw new Error(`недопустимый путь в ZIP: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`ZIP: метод сжатия ${method} не поддерживается (${name})`);
    files.push({ rel, content });
  }
  return files;
}

async function main() {
  const artifact = await findArtifact();
  console.log(`Артефакт: ${artifact.name} (${(artifact.size_in_bytes / 1048576).toFixed(2)} МБ, id ${artifact.id})`);
  const zipPath = path.join(outDir, `${artifact.name}.zip`);
  const attempts = [artifact.archive_download_url, artifact.archive_download_url.replace("/zip", "")];
  let buf = null;
  for (const url of attempts) {
    try {
      await download(url, zipPath);
      buf = await readFile(zipPath);
      break;
    } catch (err) {
      console.warn(`  не удалось по ${url}: ${err.message}`);
    }
  }
  if (!buf) throw new Error("не удалось скачать артефакт ни по одной ссылке");
  if (buf[0] === 0x7b) {
    // JSON-ответ вместо ZIP: берём прямую подписанную ссылку.
    const meta = JSON.parse(buf.toString("utf8"));
    if (!meta.archive_download_url) throw new Error(`в ответе нет archive_download_url: ${buf.toString("utf8").slice(0, 300)}`);
    await download(meta.archive_download_url, zipPath);
    buf = await readFile(zipPath);
  }
  console.log(`Скачано: ${zipPath} (${(buf.length / 1048576).toFixed(2)} МБ)`);
  const files = unzip(buf, outDir);
  for (const f of files) {
    const full = path.join(outDir, f.rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content);
  }
  console.log(`Распаковано файлов: ${files.length} → ${outDir}`);
  const top = new Set(files.map((f) => f.rel.split("/")[0]));
  console.log(`Верхний уровень: ${[...top].slice(0, 20).join(", ")}`);
}

main().catch((err) => {
  console.error("ОШИБКА:", err.message);
  process.exit(1);
});
