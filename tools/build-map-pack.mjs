#!/usr/bin/env node
// Build-time генератор компактного офлайн OSM map pack (без runtime-вызовов Overpass API).
// Использование: node tools/build-map-pack.mjs <raw-overpass.json> <out-pack.json> [toleranceMeters]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , inArg, outArg, tolArg] = process.argv;
if (!inArg || !outArg) {
  console.error("Использование: node tools/build-map-pack.mjs <raw-overpass.json> <out-pack.json> [toleranceM=0.8]");
  process.exit(1);
}

const toleranceM = Math.max(0.1, Number(tolArg ?? 0.8) || 0.8);
const raw = JSON.parse(readFileSync(resolve(inArg), "utf8"));
if (!raw || !Array.isArray(raw.elements)) {
  console.error("Ожидается выгрузка Overpass JSON с массивом elements.");
  process.exit(1);
}

// Упрощение ломаной алгоритмом Рамера — Дугласа — Пекера (в градусах с поправкой на широту)
function simplifyRdp(pts, epsM) {
  if (pts.length <= 2) return pts;
  const latScale = 111_132;
  const lonScale = 111_320 * Math.cos((pts[0].lat * Math.PI) / 180);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const bx = (b.lon - a.lon) * lonScale;
  const by = (b.lat - a.lat) * latScale;
  const len2 = bx * bx + by * by;
  let maxDist = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = (pts[i].lon - a.lon) * lonScale;
    const py = (pts[i].lat - a.lat) * latScale;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > epsM) {
    const left = simplifyRdp(pts.slice(0, idx + 1), epsM);
    const right = simplifyRdp(pts.slice(idx), epsM);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

const KEEP_HIGHWAYS = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "residential", "living_street", "unclassified", "service",
]);

const compactElements = [];
for (const el of raw.elements) {
  if (el.type === "node") {
    if (!el.tags || el.tags.highway === "traffic_signals" || el.tags.highway === "crossing") {
      compactElements.push({
        type: "node",
        id: el.id,
        lat: Number(el.lat.toFixed(6)),
        lon: Number(el.lon.toFixed(6)),
        ...(el.tags ? { tags: el.tags } : {}),
      });
    }
  } else if (el.type === "way" && el.tags) {
    if (!KEEP_HIGHWAYS.has(el.tags.highway) && !el.tags.building) continue;
    const geom = Array.isArray(el.geometry) ? simplifyRdp(el.geometry, toleranceM) : undefined;
    compactElements.push({
      type: "way",
      id: el.id,
      ...(geom
        ? { geometry: geom.map((p) => ({ lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) })) }
        : { nodes: el.nodes }),
      tags: {
        ...(el.tags.highway ? { highway: el.tags.highway } : {}),
        ...(el.tags.building ? { building: el.tags.building } : {}),
        ...(el.tags["building:levels"] ? { "building:levels": el.tags["building:levels"] } : {}),
        ...(el.tags.height ? { height: el.tags.height } : {}),
        ...(el.tags.width ? { width: el.tags.width } : {}),
        ...(el.tags.lanes ? { lanes: el.tags.lanes } : {}),
        ...(el.tags.maxspeed ? { maxspeed: el.tags.maxspeed } : {}),
        ...(el.tags.name ? { name: el.tags.name } : {}),
      },
    });
  }
}

const pack = {
  _meta: {
    schema: "cdt.osm-pack.v1",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL 1.0 — https://www.openstreetmap.org/copyright",
    generatedAt: new Date().toISOString().slice(0, 10),
    simplifyToleranceM: toleranceM,
  },
  elements: compactElements,
};

writeFileSync(resolve(outArg), JSON.stringify(pack), "utf8");
console.log(`Готово: ${compactElements.length} объектов сохранено в ${outArg} (ODbL 1.0)`);
