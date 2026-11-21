/**
 * Одноразовый ручной бенчмарк рендеринга OSM-зданий.
 *
 * Запуск после npm run build и локального HTTP-сервера:
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   python3 -m http.server 4173 --directory dist
 *   node tests/perf-benchmark.mjs http://127.0.0.1:4173/index.html
 *
 * Сценарии 100/400/900 зданий; результаты выводятся в JSON.
 * textureBytesEstimate — расчётный объём текстур, связанных с материалами сцены,
 * а не точное показание VRAM драйвера. Бенчмарк не является постоянным CI-gate.
 */
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:4173/index.html";
const counts = (process.argv[3] || "100,400,900").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (!counts.length) throw new Error("Укажите хотя бы одно положительное число зданий.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

function makeOsm(buildingCount) {
  const cols = Math.ceil(Math.sqrt(buildingCount));
  const rows = Math.ceil(buildingCount / cols);
  const lat0 = 55.75, lon0 = 37.61;
  const latStep = 0.00009, lonStep = 0.00014;
  const latHalf = 0.000018, lonHalf = 0.000027;
  const nodes = [];
  const ways = [];
  let nodeId = 1;
  for (let i = 0; i < buildingCount; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const lat = lat0 + row * latStep, lon = lon0 + col * lonStep;
    const refs = [
      [lat - latHalf, lon - lonHalf],
      [lat - latHalf, lon + lonHalf],
      [lat + latHalf, lon + lonHalf],
      [lat + latHalf, lon - lonHalf],
    ];
    const ids = refs.map(([a, o]) => {
      const id = nodeId++;
      nodes.push(`<node id="${id}" lat="${a.toFixed(7)}" lon="${o.toFixed(7)}"/>`);
      return id;
    });
    ways.push(`<way id="${100000 + i}">${ids.map((id) => `<nd ref="${id}"/>`).join("")}<nd ref="${ids[0]}"/><tag k="building" v="residential"/><tag k="building:levels" v="${1 + (i % 5)}"/></way>`);
  }
  const roadA = nodeId++, roadB = nodeId++;
  nodes.push(`<node id="${roadA}" lat="${(lat0 - 0.00012).toFixed(7)}" lon="${(lon0 - 0.00012).toFixed(7)}"/>`);
  nodes.push(`<node id="${roadB}" lat="${(lat0 - 0.00012).toFixed(7)}" lon="${(lon0 + cols * lonStep).toFixed(7)}"/>`);
  ways.push(`<way id="999999"><nd ref="${roadA}"/><nd ref="${roadB}"/><tag k="highway" v="residential"/><tag k="name" v="Benchmark Street"/></way>`);
  const bounds = `<bounds minlat="${(lat0 - 0.0003).toFixed(7)}" minlon="${(lon0 - 0.0003).toFixed(7)}" maxlat="${(lat0 + rows * latStep + 0.0003).toFixed(7)}" maxlon="${(lon0 + cols * lonStep + 0.0003).toFixed(7)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">${bounds}${nodes.join("")}${ways.join("")}</osm>`;
}

async function runScenario(browser, buildingCount) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 240)); });

  const startedAt = performance.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { state: "visible", timeout: 30000 });
  await page.getByRole("button", { name: /Свой сценарий/ }).first().click();
  await page.getByTestId("editor-import-input").setInputFiles({
    name: `buildings-${buildingCount}.osm`,
    mimeType: "application/xml",
    buffer: Buffer.from(makeOsm(buildingCount)),
  });
  await page.getByTestId("editor-odbl-banner").waitFor({ state: "visible", timeout: 30000 });
  await page.getByRole("button", { name: /Открыть в тренажёре/ }).click();
  const metrics = page.getByTestId("sim-perf-metrics");
  await metrics.waitFor({ state: "visible", timeout: 45000 });
  const readyMs = Math.round(performance.now() - startedAt);
  await sleep(3500);

  const samples = [];
  for (let i = 0; i < 12; i++) {
    const attrs = await metrics.evaluate((el) => {
      const number = (key) => Number(el.getAttribute(`data-${key}`) || 0);
      return {
        fps: number("fps"),
        p95FrameMs: number("p95-frame-ms"),
        drawCalls: number("draw-calls"),
        triangles: number("triangles"),
        geometries: number("geometries"),
        textures: number("textures"),
        textureBytesEstimate: number("texture-bytes-estimate"),
        visibleBuildings: number("visible-buildings"),
        totalBuildings: number("total-buildings"),
      };
    });
    samples.push(attrs);
    await sleep(500);
  }

  const webgl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") || canvas?.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
    };
  });

  const result = {
    requestedBuildings: buildingCount,
    importedBuildings: samples.at(-1)?.totalBuildings ?? 0,
    visibleBuildingsMedian: median(samples.map((x) => x.visibleBuildings)),
    readyMs,
    fpsMedian: median(samples.map((x) => x.fps)),
    p95FrameMsMedian: median(samples.map((x) => x.p95FrameMs)),
    drawCallsMedian: median(samples.map((x) => x.drawCalls)),
    trianglesMedian: median(samples.map((x) => x.triangles)),
    geometriesMedian: median(samples.map((x) => x.geometries)),
    texturesMedian: median(samples.map((x) => x.textures)),
    textureBytesEstimate: median(samples.map((x) => x.textureBytesEstimate)),
    webgl,
    errors: errors.slice(0, 10),
  };
  await context.close();
  if (result.importedBuildings !== buildingCount) {
    throw new Error(`Импортировано ${result.importedBuildings} зданий вместо ${buildingCount}: ${JSON.stringify(result)}`);
  }
  if (result.errors.length) throw new Error(`Ошибки браузера: ${JSON.stringify(result.errors)}`);
  return result;
}

const browser = await chromium.launch({ headless: true, args: ["--enable-webgl", "--ignore-gpu-blocklist"] });
try {
  const results = [];
  for (const count of counts) {
    results.push(await runScenario(browser, count));
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    url,
    note: "Texture memory is an estimate; browser/driver VRAM allocation is not directly exposed by WebGL.",
    results,
  }, null, 2));
} finally {
  await browser.close();
}
