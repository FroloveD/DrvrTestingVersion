/**
 * @module render/cityBuildings
 * @layer three-render
 * @role Процедурные здания РФ/СНГ (панельные П-44, кирпичные, школы/административные, коммерческие) с цоколем, витринами/подъездами, лоджиями, карнизом, деталями кровли, многоярусные деревья (вкл. берёзы) и облачное небо.
 * @invariants #8 (100 % офлайн — ноль внешних ассетов), #13 (полностью статично для стабильности зеркал).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { ObstacleBox } from "../sim/types";

type BuildingStyle = "panel" | "brick" | "civic" | "commercial";

export type CityEnvironmentPack = {
  facadeTemplates: Record<BuildingStyle, { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture }>;
  roofMat: THREE.MeshStandardMaterial;
  plinthMat: THREE.MeshStandardMaterial;
  corniceMat: THREE.MeshStandardMaterial;
  metalFlashMat: THREE.MeshStandardMaterial;
  balconyGlassMat: THREE.MeshStandardMaterial;
  balconyFrameMat: THREE.MeshStandardMaterial;
  doorMat: THREE.MeshStandardMaterial;
  apronMat: THREE.MeshStandardMaterial;
  barkMat: THREE.MeshStandardMaterial;
  birchMat: THREE.MeshStandardMaterial;
  soilMat: THREE.MeshStandardMaterial;
  foliageMats: THREE.MeshStandardMaterial[];
  spruceMat: THREE.MeshStandardMaterial;
};

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function makeRng(seedInit: number): () => number {
  let s = (seedInit % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Живописное дневное небо средней полосы с мягкими слоисто-кучевыми облаками и дымкой у горизонта (512×256). */
export function makeCloudySkyTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#2f6299");
  grad.addColorStop(0.36, "#5d93c6");
  grad.addColorStop(0.68, "#9ec3e2");
  grad.addColorStop(0.88, "#cde0ef");
  grad.addColorStop(1, "#e2ecf4");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Мягкие облачные гряды в верхней/средней части неба
  const rand = makeRng(2026);
  for (let i = 0; i < 48; i++) {
    const cx = rand() * w;
    const cy = 38 + rand() * 118;
    const rx = 28 + rand() * 68;
    const ry = 8 + rand() * 18;
    const alpha = 0.08 + rand() * 0.14;
    g.save();
    g.translate(cx, cy);
    g.scale(1, ry / rx);
    const cg = g.createRadialGradient(0, -rx * 0.15, 2, 0, 0, rx);
    cg.addColorStop(0, `rgba(252,254,255,${alpha})`);
    cg.addColorStop(0.65, `rgba(232,241,250,${alpha * 0.55})`);
    cg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = cg;
    g.beginPath();
    g.arc(0, 0, rx, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Текстура коры берёзы (белая береста с характерными тёмными горизонтальными чечевичками). */
function makeBirchBarkTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e5e4df";
  g.fillRect(0, 0, 64, 128);
  // Тёмный комель у земли
  const base = g.createLinearGradient(0, 96, 0, 128);
  base.addColorStop(0, "rgba(42,40,38,0)");
  base.addColorStop(1, "rgba(38,36,34,0.85)");
  g.fillStyle = base;
  g.fillRect(0, 96, 64, 32);

  const rand = makeRng(6113);
  for (let i = 0; i < 55; i++) {
    g.fillStyle = rand() < 0.7 ? "#2b2a28" : "#6b6860";
    g.fillRect(Math.floor(rand() * 58), Math.floor(rand() * 116), 4 + Math.floor(rand() * 11), 2 + Math.floor(rand() * 2));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Текстура наплавляемой рулонной кровли (Технониколь) с полосами рулонов и зерном посыпки. */
function makeRoofMembraneTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a4047";
  g.fillRect(0, 0, 128, 128);
  const rand = makeRng(8123);
  for (let y = 0; y < 128; y += 16) {
    g.fillStyle = y % 32 === 0 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.05)";
    g.fillRect(0, y, 128, 15);
    g.fillStyle = "#262b30";
    g.fillRect(0, y, 128, 1.5);
  }
  for (let i = 0; i < 900; i++) {
    const v = 46 + Math.floor(rand() * 28);
    g.fillStyle = `rgb(${v},${v + 2},${v + 4})`;
    g.fillRect(Math.floor(rand() * 128), Math.floor(rand() * 128), 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Генерирует бесшовный тайл фасада 256×256 (4 проёма × 4 этажа ≈ 12.8 × 12.4 м) + карту рельефа `bumpMap`:
 * `panel` (швы ЖБИ, ПВХ-окна с форточкой, кондиционеры), `brick` (кладка + перемычки + подоконники),
 * `civic` (руст, широкие школьные/адм. окна), `commercial` (керамогранит + широкое витражное остекление).
 */
function makeFacadeTile(style: BuildingStyle): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d")!;

  const bc = document.createElement("canvas");
  bc.width = s;
  bc.height = s;
  const bg = bc.getContext("2d")!;

  const rand = makeRng(hashString(style));

  // Базовая фактура стены (нейтрально-светлая, чтобы мягко тонироваться цветом здания)
  g.fillStyle = style === "brick" ? "#d6c8be" : style === "panel" ? "#d8dde2" : "#dfe3e6";
  g.fillRect(0, 0, s, s);
  bg.fillStyle = "#b8b8b8";
  bg.fillRect(0, 0, s, s);

  if (style === "panel") {
    // Межпанельные герметизированные швы серийного дома П-44 / 111
    g.strokeStyle = "rgba(68, 76, 86, 0.55)";
    g.lineWidth = 2;
    bg.strokeStyle = "#484848";
    bg.lineWidth = 2.5;
    for (let i = 0; i <= 4; i++) {
      const p = i * 64;
      g.beginPath();
      g.moveTo(p, 0); g.lineTo(p, s);
      g.moveTo(0, p); g.lineTo(s, p);
      g.stroke();
      bg.beginPath();
      bg.moveTo(p, 0); bg.lineTo(p, s);
      bg.moveTo(0, p); bg.lineTo(s, p);
      bg.stroke();
    }
    // Лёгкая разница тона отдельных ЖБИ-плит
    for (let r = 0; r < 4; r++) {
      for (let col = 0; col < 4; col++) {
        const d = (rand() - 0.5) * 0.08;
        g.fillStyle = d > 0 ? `rgba(255,255,255,${d})` : `rgba(30,40,50,${-d})`;
        g.fillRect(col * 64 + 2, r * 64 + 2, 60, 60);
      }
    }
  } else if (style === "brick") {
    // Горизонтальные ряды кирпичной кладки
    for (let y = 0; y < s; y += 6) {
      g.fillStyle = "rgba(80, 62, 52, 0.22)";
      g.fillRect(0, y, s, 1);
      const off = ((y / 6) % 2) * 8;
      for (let x = off; x < s; x += 16) {
        if (rand() < 0.35) {
          g.fillStyle = rand() < 0.5 ? "rgba(60,35,25,0.12)" : "rgba(255,242,230,0.12)";
          g.fillRect(x + 1, y + 1, 14, 5);
        }
      }
    }
  } else if (style === "civic") {
    // Межэтажные тяги и тонкий штукатурный руст школы / МРЭО
    for (let r = 0; r < 4; r++) {
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.fillRect(0, r * 64, s, 4);
      g.fillStyle = "rgba(60,70,82,0.18)";
      g.fillRect(0, r * 64 + 4, s, 2);
    }
  } else {
    // Вентилируемый фасад из кассет керамогранита
    g.strokeStyle = "rgba(50,58,68,0.35)";
    g.lineWidth = 1.5;
    for (let x = 0; x <= s; x += 32) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke();
    }
    for (let y = 0; y <= s; y += 32) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
    }
  }

  // Микрозерно бетона / штукатурки
  for (let i = 0; i < 1200; i++) {
    g.fillStyle = rand() < 0.5 ? "rgba(0,0,0,0.045)" : "rgba(255,255,255,0.045)";
    g.fillRect(Math.floor(rand() * s), Math.floor(rand() * s), 2, 2);
  }

  // Оконные проёмы 4×4 (с глубоким откосом, белым ПВХ-переплётом, форточкой, отражением неба и шторами)
  const ww = style === "commercial" ? 48 : style === "civic" ? 42 : 34;
  const wh = style === "commercial" ? 40 : 35;

  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 4; col++) {
      const wx = col * 64 + Math.round((64 - ww) * 0.5);
      const wy = r * 64 + 13;

      // Бетонная перемычка над окном в кирпичных домах
      if (style === "brick") {
        g.fillStyle = "#e2e6ea";
        g.fillRect(wx - 3, wy - 4, ww + 6, 4);
      }

      // Углубление откоса в bumpMap и тень верхнего откоса
      bg.fillStyle = "#303030";
      bg.fillRect(wx, wy, ww, wh);
      g.fillStyle = "rgba(22, 30, 38, 0.45)";
      g.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);

      // Стеклопакет с отражением неба / тёплым дневным интерьером / шторами
      const mood = rand();
      const glassGrad = g.createLinearGradient(wx, wy, wx, wy + wh);
      if (mood < 0.16) {
        // Мягкий тёплый свет в комнате
        glassGrad.addColorStop(0, "#d8c394");
        glassGrad.addColorStop(1, "#9c845a");
      } else if (mood < 0.44) {
        // Светлые шторы / жалюзи за стеклом
        glassGrad.addColorStop(0, "#6c8aa6");
        glassGrad.addColorStop(1, "#4a6278");
      } else {
        // Глубокое дневное отражение неба
        glassGrad.addColorStop(0, "#567593");
        glassGrad.addColorStop(0.55, "#324559");
        glassGrad.addColorStop(1, "#243241");
      }
      g.fillStyle = glassGrad;
      g.fillRect(wx + 2, wy + 2, ww - 4, wh - 4);

      // Диагональный блик на стекле
      g.fillStyle = "rgba(220, 238, 255, 0.14)";
      g.beginPath();
      g.moveTo(wx + 3, wy + 3);
      g.lineTo(wx + ww * 0.55, wy + 3);
      g.lineTo(wx + 3, wy + wh * 0.72);
      g.closePath();
      g.fill();

      // Белая рама ПВХ, вертикальный импост и фрамуга/форточка
      const frameCol = style === "commercial" ? "#3b4654" : "#eef2f6";
      g.strokeStyle = frameCol;
      g.lineWidth = 2.4;
      g.strokeRect(wx + 1.5, wy + 1.5, ww - 3, wh - 3);
      g.lineWidth = 2;
      const splitX = wx + Math.round(ww * (style === "civic" ? 0.5 : 0.58));
      g.beginPath();
      g.moveTo(splitX, wy + 2);
      g.lineTo(splitX, wy + wh - 2);
      if (style !== "commercial") {
        g.moveTo(splitX, wy + 12);
        g.lineTo(wx + ww - 2, wy + 12);
      }
      g.stroke();

      // Выступающий подоконник / оцинкованный отлив с падающей тенью
      g.fillStyle = "#e6ebf0";
      g.fillRect(wx - 2, wy + wh, ww + 4, 3);
      g.fillStyle = "rgba(18, 24, 32, 0.28)";
      g.fillRect(wx - 1, wy + wh + 3, ww + 2, 2);
      bg.fillStyle = "#efefef";
      bg.fillRect(wx - 2, wy + wh, ww + 4, 3);

      // Внешний блок сплит-системы (кондиционер) под частью окон жилых домов
      if ((style === "panel" || style === "brick") && rand() < 0.2) {
        const ax = wx + ww - 13;
        const ay = wy + wh + 4;
        g.fillStyle = "#e5e9ee";
        g.fillRect(ax, ay, 13, 9);
        g.strokeStyle = "#64748b";
        g.lineWidth = 1;
        g.strokeRect(ax, ay, 13, 9);
        g.fillStyle = "#334155";
        g.beginPath();
        g.arc(ax + 5, ay + 4.5, 3.2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  const map = new THREE.CanvasTexture(c);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  return { map, bumpMap };
}

/** Создаёт общий набор текстур и материалов зданий РФ/СНГ и деревьев на один вызов `loadWorld`. */
export function createCityEnvironmentPack(): CityEnvironmentPack {
  return {
    facadeTemplates: {
      panel: makeFacadeTile("panel"),
      brick: makeFacadeTile("brick"),
      civic: makeFacadeTile("civic"),
      commercial: makeFacadeTile("commercial"),
    },
    roofMat: new THREE.MeshStandardMaterial({ map: makeRoofMembraneTexture(), roughness: 0.92 }),
    plinthMat: new THREE.MeshStandardMaterial({ color: 0x3e464f, roughness: 0.86 }),
    corniceMat: new THREE.MeshStandardMaterial({ color: 0xdbe1e7, roughness: 0.78 }),
    metalFlashMat: new THREE.MeshStandardMaterial({ color: 0x9aa6b4, metalness: 0.5, roughness: 0.42 }),
    balconyGlassMat: new THREE.MeshStandardMaterial({ color: 0x7b9ab5, roughness: 0.22, metalness: 0.35 }),
    balconyFrameMat: new THREE.MeshStandardMaterial({ color: 0xe6ecf2, roughness: 0.65 }),
    doorMat: new THREE.MeshStandardMaterial({ color: 0x2e3640, metalness: 0.35, roughness: 0.55 }),
    apronMat: new THREE.MeshStandardMaterial({ color: 0x4b535c, roughness: 0.92 }),
    barkMat: new THREE.MeshStandardMaterial({ color: 0x533c28, roughness: 0.94 }),
    birchMat: new THREE.MeshStandardMaterial({ map: makeBirchBarkTexture(), roughness: 0.86 }),
    soilMat: new THREE.MeshStandardMaterial({ color: 0x352a20, roughness: 0.97 }),
    foliageMats: [
      new THREE.MeshStandardMaterial({ color: 0x2d5e3b, roughness: 0.86 }),
      new THREE.MeshStandardMaterial({ color: 0x3b7247, roughness: 0.84 }),
      new THREE.MeshStandardMaterial({ color: 0x4d8250, roughness: 0.82 }),
      new THREE.MeshStandardMaterial({ color: 0x5c8945, roughness: 0.84 }),
    ],
    spruceMat: new THREE.MeshStandardMaterial({ color: 0x234c37, roughness: 0.88 }),
  };
}

/** Палитра реалистичных оттенков фасадов РФ/СНГ (без кислотных цветов, с хорошей читаемостью знаков). */
const RU_PALETTES: Record<BuildingStyle, number[]> = {
  panel: [0xcfd8df, 0xd8cfc2, 0xc3d2dc, 0xd4d8d2, 0xcbc7d4],
  brick: [0xb97b63, 0xc89a78, 0xd4c3a3, 0xa86c58, 0xc7b59b],
  civic: [0xdad2be, 0xc8d4dd, 0xd8dfd4, 0xdfd3c3],
  commercial: [0xb8c2cc, 0xc6ccd2, 0xaab6c2],
};

function chooseBuildingStyle(obs: ObstacleBox, seed: number): { style: BuildingStyle; tint: number } {
  const lbl = (obs.label ?? "").toLowerCase();
  let style: BuildingStyle;
  if (lbl.includes("школ") || lbl.includes("мрэо") || lbl.includes("админ") || lbl.includes("корпус")) {
    style = "civic";
  } else if (obs.height < 7.2) {
    style = "commercial";
  } else if (obs.height >= 16.5) {
    style = seed % 3 === 0 ? "brick" : "panel";
  } else {
    style = seed % 2 === 0 ? "brick" : "panel";
  }
  const list = RU_PALETTES[style];
  return { style, tint: list[seed % list.length] };
}

/** Создаёт BoxGeometry здания с мировым масштабом окон отдельно для продольных и торцевых стен (без растяжения UV). */
function makeScaledBuildingBox(w: number, h: number, l: number): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(w, h, l);
  const uv = geo.attributes.uv;
  if (uv) {
    // 1 тайл = 4 проёма (~12.8 м) × 4 этажа (~12.4 м); округление до 0.25 даёт целое число окон и этажей!
    const snapQuarter = (val: number) => Math.max(0.25, Math.round(val * 4) / 4);
    const repY = snapQuarter(h / 12.4);
    const repZ = snapQuarter(l / 12.8);
    const repX = snapQuarter(w / 12.8);
    for (let face = 0; face < 6; face++) {
      if (face === 2 || face === 3) continue; // крыша и низ используют roofMat
      const ru = face <= 1 ? repZ : repX;
      const base = face * 4;
      for (let k = 0; k < 4; k++) {
        const idx = base + k;
        uv.setXY(idx, uv.getX(idx) * ru, uv.getY(idx) * repY);
      }
    }
    uv.needsUpdate = true;
  }
  return geo;
}

/**
 * Строит детализированное здание РФ/СНГ (цоколь, отмостка, фасад с реальным масштабом окон,
 * подъезды с козырьками, застеклённые лоджии, карниз, парапет с отливом и надстройки кровли).
 */
export function buildRussianBuilding(obs: ObstacleBox, env: CityEnvironmentPack): THREE.Group {
  const seed = hashString(`${obs.id}:${Math.round(obs.cx)}:${Math.round(obs.cz)}`);
  const rand = makeRng(seed);
  const { style, tint } = chooseBuildingStyle(obs, seed);

  const w = Math.max(2, obs.halfX * 2);
  const l = Math.max(2, obs.halfZ * 2);
  const h = Math.max(3.2, obs.height);

  const g = new THREE.Group();
  g.position.set(obs.cx, 0, obs.cz);
  g.rotation.y = obs.h;

  const tpl = env.facadeTemplates[style];
  const wallMat = new THREE.MeshStandardMaterial({
    color: tint,
    map: tpl.map,
    bumpMap: tpl.bumpMap,
    bumpScale: 0.025,
    roughness: style === "commercial" ? 0.62 : 0.82,
  });

  // Основной объём: 4 стены с фасадом, верх (face 2) и низ (face 3) — рулонная кровля без окон
  const materials: THREE.Material[] = [wallMat, wallMat, env.roofMat, env.roofMat, wallMat, wallMat];
  const body = new THREE.Mesh(makeScaledBuildingBox(w, h, l), materials);
  body.position.y = h * 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Бетонная отмостка и выступающий гранитный/штукатурный цоколь у основания
  const plinthH = Math.min(0.72, h * 0.14);
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, plinthH, l + 0.12), env.plinthMat);
  plinth.position.y = plinthH * 0.5;
  plinth.receiveShadow = true;
  g.add(plinth);

  const apron = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.9, l + 0.9), env.apronMat);
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = 0.016;
  apron.receiveShadow = true;
  g.add(apron);

  // Межэтажный карнизный поясок над первым этажом (для школ, МРЭО и кирпичных домов)
  if ((style === "civic" || style === "brick") && h >= 7.5) {
    const belt = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.16, l + 0.16), env.corniceMat);
    belt.position.y = 3.25;
    g.add(belt);
  }

  // Венчающий карниз и периметральный парапет плоской кровли с оцинкованным отливом
  const cornice = new THREE.Mesh(new THREE.BoxGeometry(w + 0.24, 0.2, l + 0.24), env.corniceMat);
  cornice.position.y = h - 0.06;
  g.add(cornice);

  const parH = h >= 9 ? 0.52 : 0.34;
  const parT = 0.24;
  if (w >= 4.5 && l >= 4.5) {
    for (const sgn of [-1, 1]) {
      const pFront = new THREE.Mesh(new THREE.BoxGeometry(w, parH, parT), env.plinthMat);
      pFront.position.set(0, h + parH * 0.5, sgn * (l * 0.5 - parT * 0.5));
      const pSide = new THREE.Mesh(new THREE.BoxGeometry(parT, parH, l - parT * 2), env.plinthMat);
      pSide.position.set(sgn * (w * 0.5 - parT * 0.5), h + parH * 0.5, 0);
      const capF = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.04, parT + 0.08), env.metalFlashMat);
      capF.position.set(0, h + parH + 0.02, sgn * (l * 0.5 - parT * 0.5));
      g.add(pFront, pSide, capF);
    }
  }

  // Надстройки на плоской крыше: лифтовая шахта (машинное отделение) и вентиляционные стояки
  if (w >= 8 && l >= 8 && h >= 8) {
    if (h >= 12) {
      const liftW = Math.min(3.6, w * 0.28);
      const liftL = Math.min(3.8, l * 0.28);
      const liftH = 2.05;
      const ox = (rand() - 0.5) * (w - liftW - 2.4) * 0.5;
      const oz = (rand() - 0.5) * (l - liftL - 2.4) * 0.5;
      const liftBox = new THREE.Mesh(new THREE.BoxGeometry(liftW, liftH, liftL), env.corniceMat);
      liftBox.position.set(ox, h + liftH * 0.5, oz);
      liftBox.castShadow = true;
      const liftCap = new THREE.Mesh(new THREE.BoxGeometry(liftW + 0.22, 0.12, liftL + 0.22), env.roofMat);
      liftCap.position.set(ox, h + liftH + 0.06, oz);
      g.add(liftBox, liftCap);
    }

    const ventCount = Math.min(4, Math.max(1, Math.floor(Math.max(w, l) / 9)));
    const longAlongZ = l >= w;
    for (let vi = 0; vi < ventCount; vi++) {
      const pos = ((vi + 0.5) / ventCount - 0.5) * (Math.max(w, l) * 0.65);
      const vx = longAlongZ ? (w * 0.16) : pos;
      const vz = longAlongZ ? pos : (l * 0.16);
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.15, 0.55), env.corniceMat);
      shaft.position.set(vx, h + 0.575, vz);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.08, 0.72), env.metalFlashMat);
      hood.position.set(vx, h + 1.32, vz);
      g.add(shaft, hood);
    }
  }

  // Подъезд с металлической дверью и бетонным козырьком + застеклённые балконы/лоджии (строго выше 3.4 м)
  const longAlongZ = l >= w;
  const facadeSpan = longAlongZ ? l : w;
  const halfDepth = (longAlongZ ? w : l) * 0.5;

  if (facadeSpan >= 11 && h >= 6.5) {
    const entrances = style === "panel" || style === "brick" ? Math.min(3, Math.max(1, Math.floor(facadeSpan / 15))) : 1;
    for (let ei = 0; ei < entrances; ei++) {
      const along = ((ei + 0.5) / entrances - 0.5) * (facadeSpan * 0.68);
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.25, 0.08), env.doorMat);
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.13, 0.55), env.corniceMat);
      if (longAlongZ) {
        door.rotation.y = Math.PI / 2;
        canopy.rotation.y = Math.PI / 2;
        door.position.set(halfDepth + 0.03, 1.15, along);
        canopy.position.set(halfDepth + 0.24, 2.48, along);
      } else {
        door.position.set(along, 1.15, halfDepth + 0.03);
        canopy.position.set(along, 2.48, halfDepth + 0.24);
      }
      g.add(door, canopy);
    }
  }

  // Застеклённые лоджии жилых домов (2–6 этажи, выступ 0.32 м на высоте >= 3.6 м — не задевают авто)
  if ((style === "panel" || style === "brick") && facadeSpan >= 12 && h >= 10.5) {
    const cols = Math.min(4, Math.max(2, Math.floor(facadeSpan / 7.5)));
    const floors = Math.min(6, Math.floor((h - 3.6) / 3.1));
    const balW = 2.55;
    const balD = 0.34;
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const along = ((cIdx + 0.5) / cols - 0.5) * (facadeSpan * 0.76);
      // Вертикальный эркер застеклённых лоджий — всего 2 меша на целый стояк (минимум draw calls!)
      const stackH = floors * 3.05 - 0.35;
      if (stackH < 2.2) continue;
      const baseY = 3.65 + stackH * 0.5;
      const apronBox = new THREE.Mesh(
        new THREE.BoxGeometry(longAlongZ ? balD : balW, stackH, longAlongZ ? balW : balD),
        env.balconyFrameMat
      );
      const glassBox = new THREE.Mesh(
        new THREE.BoxGeometry(longAlongZ ? balD + 0.03 : balW - 0.18, stackH - 0.3, longAlongZ ? balW - 0.18 : balD + 0.03),
        env.balconyGlassMat
      );
      for (const side of [-1, 1]) {
        const aClone = side === 1 ? apronBox : apronBox.clone();
        const gClone = side === 1 ? glassBox : glassBox.clone();
        if (longAlongZ) {
          aClone.position.set(side * (halfDepth + balD * 0.45), baseY, along);
          gClone.position.set(side * (halfDepth + balD * 0.45), baseY + 0.08, along);
        } else {
          aClone.position.set(along, baseY, side * (halfDepth + balD * 0.45));
          gClone.position.set(along, baseY + 0.08, side * (halfDepth + balD * 0.45));
        }
        g.add(aClone, gClone);
      }
    }
  }

  return g;
}

/**
 * Строит реалистичное городское дерево РФ/СНГ (липа/клён с многоярусной кроной, русская берёза или ель)
 * с развилкой ветвей и приствольной лункой у земли.
 */
/**
 * Упрощённый инстансинг деревьев для больших OSM-сцен.
 * Сохраняет детерминированный тип/масштаб/цвет, но заменяет набор мелких мешей
 * двумя батчами на дерево (ствол + крона), отдельно внутри пространственных ячеек.
 */
export function buildOsmTreeInstances(
  group: THREE.Group,
  trees: ObstacleBox[],
  env: CityEnvironmentPack
): void {
  const cellSize = 96;
  const trunkGeometry = new THREE.CylinderGeometry(1, 1, 1, 7);
  const foliageGeometry = new THREE.IcosahedronGeometry(1, 1);
  const spruceGeometry = new THREE.ConeGeometry(1, 1, 9);
  const dummy = new THREE.Object3D();

  type TreeInstance = { x: number; z: number; height: number; seed: number };
  const cells = new Map<string, TreeInstance[]>();
  for (const tree of trees) {
    const seed = hashString(`${tree.id}:${Math.round(tree.cx * 10)}:${Math.round(tree.cz * 10)}`);
    const key = `${Math.floor(tree.cx / cellSize)},${Math.floor(tree.cz / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push({ x: tree.cx, z: tree.cz, height: Math.max(3.4, tree.height), seed });
    cells.set(key, bucket);
  }

  for (const [key, bucket] of cells) {
    const [gx, gz] = key.split(",").map(Number);
    const centerX = (gx + 0.5) * cellSize;
    const centerZ = (gz + 0.5) * cellSize;
    const trunkGroups = new Map<THREE.Material, TreeInstance[]>();
    const crownGroups = new Map<string, TreeInstance[]>();

    for (const tree of bucket) {
      const kind = tree.seed % 9;
      const isSpruce = kind === 0;
      const isBirch = kind === 1 || kind === 2;
      const trunkMat = isBirch ? env.birchMat : env.barkMat;
      const trunkBucket = trunkGroups.get(trunkMat) ?? [];
      trunkBucket.push(tree);
      trunkGroups.set(trunkMat, trunkBucket);
      const foliageIndex = tree.seed % env.foliageMats.length;
      const crownKey = isSpruce ? `spruce:${foliageIndex}` : `leaf:${foliageIndex}`;
      const crownBucket = crownGroups.get(crownKey) ?? [];
      crownBucket.push(tree);
      crownGroups.set(crownKey, crownBucket);
    }

    const makeMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.position.set(centerX, 0, centerZ);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      return mesh;
    };

    for (const [material, instances] of trunkGroups) {
      const mesh = makeMesh(trunkGeometry, material, instances.length);
      instances.forEach((tree, index) => {
        const rand = makeRng(tree.seed);
        const h = tree.height * (0.94 + rand() * 0.22);
        const isBirch = tree.seed % 9 === 1 || tree.seed % 9 === 2;
        const trunkH = h * (isBirch ? 0.54 : 0.45);
        const radius = isBirch ? 0.14 : 0.2;
        dummy.position.set(tree.x - centerX, trunkH * 0.5, tree.z - centerZ);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.scale.set(radius, trunkH, radius);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }

    for (const [crownKey, instances] of crownGroups) {
      const [kind, foliageIndexText] = crownKey.split(":");
      const isSpruce = kind === "spruce";
      const geometry = isSpruce ? spruceGeometry : foliageGeometry;
      const material = isSpruce ? env.spruceMat : env.foliageMats[Number(foliageIndexText)];
      const mesh = makeMesh(geometry, material, instances.length);
      instances.forEach((tree, index) => {
        const rand = makeRng(tree.seed);
        const h = tree.height * (0.94 + rand() * 0.22);
        const isBirch = tree.seed % 9 === 1 || tree.seed % 9 === 2;
        if (isSpruce) {
          dummy.position.set(tree.x - centerX, h * 0.65, tree.z - centerZ);
          dummy.scale.set(h * 0.34, h * 0.7, h * 0.34);
        } else {
          const trunkH = h * (isBirch ? 0.54 : 0.45);
          const crownR = h * (isBirch ? 0.25 : 0.3);
          dummy.position.set(tree.x - centerX, trunkH + crownR * 0.62, tree.z - centerZ);
          dummy.scale.set(crownR * 1.05, crownR * 0.95, crownR);
        }
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  // Геометрии разделяются между ячейками и освобождаются при очистке worldGroup.
  void trunkGeometry;
  void foliageGeometry;
  void spruceGeometry;
}

export function buildRealisticTree(
  x: number,
  z: number,
  height: number,
  env: CityEnvironmentPack,
  idHint = ""
): THREE.Group {
  const seed = hashString(`${idHint}:${Math.round(x * 10)}:${Math.round(z * 10)}`);
  const rand = makeRng(seed);
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rand() * Math.PI * 2;

  const h = Math.max(3.2, height * (0.94 + rand() * 0.22));
  const kindRoll = seed % 9;
  const isSpruce = kindRoll === 0;
  const isBirch = kindRoll === 1 || kindRoll === 2;

  // Приствольная лунка с тёмным грунтом и аккуратным каменным кольцом
  const pitRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.56, 12), env.apronMat);
  pitRing.rotation.x = -Math.PI / 2;
  pitRing.position.y = 0.022;
  const soil = new THREE.Mesh(new THREE.CircleGeometry(0.43, 12), env.soilMat);
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = 0.021;
  g.add(pitRing, soil);

  if (isSpruce) {
    // Городская голубовато-зелёная ель (4 яруса хвои)
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.17, h * 0.35, 7), env.barkMat);
    trunk.position.y = h * 0.175;
    trunk.castShadow = true;
    g.add(trunk);

    const tiers: Array<[number, number, number]> = [
      [0.34, 0.36, 0.38],
      [0.52, 0.3, 0.34],
      [0.69, 0.23, 0.3],
      [0.84, 0.15, 0.26],
    ];
    for (const [fy, fr, fh] of tiers) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(h * fr, h * fh, 9), env.spruceMat);
      cone.position.y = h * fy;
      cone.castShadow = true;
      g.add(cone);
    }
    return g;
  }

  // Ствол и две расходящиеся скелетные ветви (берёза или липа/клён)
  const trunkMat = isBirch ? env.birchMat : env.barkMat;
  const trunkH = h * (isBirch ? 0.54 : 0.45);
  const baseR = isBirch ? 0.14 : 0.2;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(baseR * 0.58, baseR, trunkH, 8), trunkMat);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  g.add(trunk);

  for (const sgn of [-1, 1]) {
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.08, trunkH * 0.42, 6), trunkMat);
    limb.rotation.z = sgn * 0.52;
    limb.position.set(sgn * 0.22, trunkH * 0.9, sgn * 0.06);
    g.add(limb);
  }

  // Многоярусная живая крона из 4 объёмов с естественной игрой оттенков листвы
  const baseR2 = h * (isBirch ? 0.25 : 0.3);
  const baseMatIdx = seed % env.foliageMats.length;
  const puffs: Array<[number, number, number, number, number, number]> = [
    [0, trunkH + baseR2 * 0.55, 0, baseR2 * 1.05, 0.88, 0],
    [-baseR2 * 0.48, trunkH + baseR2 * 0.38, baseR2 * 0.26, baseR2 * 0.78, 0.86, 1],
    [baseR2 * 0.46, trunkH + baseR2 * 0.44, -baseR2 * 0.28, baseR2 * 0.8, 0.9, 1],
    [baseR2 * 0.06, trunkH + baseR2 * 1.12, baseR2 * 0.05, baseR2 * 0.74, isBirch ? 1.15 : 0.92, 2],
  ];
  for (const [px, py, pz, r, sy, shadeStep] of puffs) {
    const mat = env.foliageMats[(baseMatIdx + shadeStep) % env.foliageMats.length];
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat);
    puff.scale.set(1, sy, 0.96);
    puff.position.set(px, py, pz);
    puff.castShadow = true;
    puff.receiveShadow = true;
    g.add(puff);
  }

  return g;
}
