/**
 * @module render/cityBuildings
 * @layer three-render
 * @role Процедурные здания РФ/СНГ (панельные П-44, кирпичные, школы/административные, коммерческие) с цоколем, витринами/подъездами, лоджиями, карнизом, деталями кровли, многоярусные деревья (вкл. берёзы) и облачное небо.
 * @invariants #8 (100 % офлайн — ноль внешних ассетов), #13 (полностью статично для стабильности зеркал).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { ObstacleBox } from "../sim/types";
import type { SpatialChunkBatcher } from "./staticBatcher";

type BuildingStyle = "panel" | "brick" | "civic" | "commercial";

export type CityEnvironmentPack = {
  facadeTemplates: Record<BuildingStyle, { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture }>;
  facadeMats: Record<BuildingStyle, THREE.MeshStandardMaterial[]>;
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
  protoGeos: {
    pitRing: THREE.BufferGeometry;
    soilDisc: THREE.BufferGeometry;
    trunk: THREE.BufferGeometry;
    limb: THREE.BufferGeometry;
    spruceCone: THREE.BufferGeometry;
    foliagePuff: THREE.BufferGeometry;
  };
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

/** Палитра реалистичных оттенков фасадов РФ/СНГ (без кислотных цветов, с хорошей читаемостью знаков). */
const RU_PALETTES: Record<BuildingStyle, number[]> = {
  panel: [0xcfd8df, 0xd8cfc2, 0xc3d2dc, 0xd4d8d2, 0xcbc7d4],
  brick: [0xb97b63, 0xc89a78, 0xd4c3a3, 0xa86c58, 0xc7b59b],
  civic: [0xdad2be, 0xc8d4dd, 0xd8dfd4, 0xdfd3c3],
  commercial: [0xb8c2cc, 0xc6ccd2, 0xaab6c2],
};

/** Создаёт общий пул текстур, 17 фасадных материалов и прототипов деревьев на один вызов `loadWorld`. */
export function createCityEnvironmentPack(): CityEnvironmentPack {
  const facadeTemplates: Record<BuildingStyle, { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture }> = {
    panel: makeFacadeTile("panel"),
    brick: makeFacadeTile("brick"),
    civic: makeFacadeTile("civic"),
    commercial: makeFacadeTile("commercial"),
  };
  const makeStyleMats = (style: BuildingStyle) => {
    const tpl = facadeTemplates[style];
    const roughness = style === "commercial" ? 0.62 : 0.82;
    return RU_PALETTES[style].map(
      (color) =>
        new THREE.MeshStandardMaterial({
          color,
          map: tpl.map,
          bumpMap: tpl.bumpMap,
          bumpScale: 0.025,
          roughness,
        })
    );
  };

  const pitRing = new THREE.RingGeometry(0.42, 0.56, 10);
  pitRing.rotateX(-Math.PI / 2);
  const soilDisc = new THREE.CircleGeometry(0.43, 10);
  soilDisc.rotateX(-Math.PI / 2);

  return {
    facadeTemplates,
    facadeMats: {
      panel: makeStyleMats("panel"),
      brick: makeStyleMats("brick"),
      civic: makeStyleMats("civic"),
      commercial: makeStyleMats("commercial"),
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
    protoGeos: {
      pitRing,
      soilDisc,
      trunk: new THREE.CylinderGeometry(0.58, 1, 1, 7),
      limb: new THREE.CylinderGeometry(0.56, 1, 1, 5),
      spruceCone: new THREE.ConeGeometry(1, 1, 8),
      foliagePuff: new THREE.DodecahedronGeometry(1, 0),
    },
  };
}

/** Освобождает временные прототипы и возвращает полный список материалов/текстур пакета для `dispose`. */
export function finalizeCityEnvironmentPack(env: CityEnvironmentPack): {
  materials: THREE.Material[];
  textures: THREE.Texture[];
} {
  Object.values(env.protoGeos).forEach((g) => g.dispose());
  const materials: THREE.Material[] = [
    ...env.facadeMats.panel,
    ...env.facadeMats.brick,
    ...env.facadeMats.civic,
    ...env.facadeMats.commercial,
    env.roofMat,
    env.plinthMat,
    env.corniceMat,
    env.metalFlashMat,
    env.balconyGlassMat,
    env.balconyFrameMat,
    env.doorMat,
    env.apronMat,
    env.barkMat,
    env.birchMat,
    env.soilMat,
    ...env.foliageMats,
    env.spruceMat,
  ];
  const textures: THREE.Texture[] = [];
  for (const tpl of Object.values(env.facadeTemplates)) {
    textures.push(tpl.map, tpl.bumpMap);
  }
  if (env.roofMat.map) textures.push(env.roofMat.map);
  if (env.birchMat.map) textures.push(env.birchMat.map);
  return { materials, textures };
}

function chooseBuildingStyle(obs: ObstacleBox, seed: number): { style: BuildingStyle; mat: THREE.MeshStandardMaterial } {
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
  return { style, mat: envMatPick(style, seed) };
}

let _activeEnv: CityEnvironmentPack | null = null;
function envMatPick(style: BuildingStyle, seed: number): THREE.MeshStandardMaterial {
  const list = _activeEnv!.facadeMats[style];
  return list[seed % list.length];
}

/**
 * Пакетно записывает детализированное здание РФ/СНГ (цоколь, отмостка, фасад с реальным масштабом окон,
 * подъезды с козырьками, застеклённые лоджии, карниз, парапет с отливом и надстройки кровли) в пространственный чанк.
 * Ноль отдельных `THREE.Mesh` на здание — десятки тысяч деталей сливаются в несколько draw calls на квартал!
 */
export function emitRussianBuilding(chunks: SpatialChunkBatcher, obs: ObstacleBox, env: CityEnvironmentPack): void {
  _activeEnv = env;
  const seed = hashString(`${obs.id}:${Math.round(obs.cx)}:${Math.round(obs.cz)}`);
  const rand = makeRng(seed);
  const { style, mat: wallMat } = chooseBuildingStyle(obs, seed);

  const w = Math.max(2, obs.halfX * 2);
  const l = Math.max(2, obs.halfZ * 2);
  const h = Math.max(3.2, obs.height);
  const cx = obs.cx;
  const cz = obs.cz;
  const yaw = obs.h;
  const sh = Math.sin(yaw);
  const ch = Math.cos(yaw);
  const wx = (lx: number, lz: number) => cx + lx * ch + lz * sh;
  const wz = (lx: number, lz: number) => cz - lx * sh + lz * ch;

  const batch = chunks.atBuilding(cx, cz, Math.hypot(w, l) * 0.5 + 1);

  // 1. Основной объём: 4 стены с фасадом в мировом масштабе + верхняя грань рулонной кровли (без дна)
  batch.addBox(wallMat, cx, h * 0.5, cz, w, h, l, yaw, {
    castShadow: true,
    receiveShadow: true,
    roofMat: env.roofMat,
  });

  // 2. Бетонная отмостка и выступающий гранитный/штукатурный цоколь у основания
  const plinthH = Math.min(0.72, h * 0.14);
  batch.addBox(env.plinthMat, cx, plinthH * 0.5, cz, w + 0.12, plinthH, l + 0.12, yaw, { receiveShadow: true });
  batch.addFlatQuad(env.apronMat, cx, 0.016, cz, w + 0.9, l + 0.9, yaw, true);

  // 3. Межэтажный карнизный поясок и венчающий карниз
  if ((style === "civic" || style === "brick") && h >= 7.5) {
    batch.addBox(env.corniceMat, cx, 3.25, cz, w + 0.16, 0.16, l + 0.16, yaw);
  }
  batch.addBox(env.corniceMat, cx, h - 0.06, cz, w + 0.24, 0.2, l + 0.24, yaw);

  // 4. Периметральный парапет плоской кровли с оцинкованным отливом
  const parH = h >= 9 ? 0.52 : 0.34;
  const parT = 0.24;
  if (w >= 4.5 && l >= 4.5) {
    const py = h + parH * 0.5;
    const zOff = l * 0.5 - parT * 0.5;
    const xOff = w * 0.5 - parT * 0.5;
    for (const sgn of [-1, 1]) {
      const fzPos = sgn * zOff;
      const sxPos = sgn * xOff;
      batch.addBox(env.plinthMat, wx(0, fzPos), py, wz(0, fzPos), w, parH, parT, yaw);
      batch.addBox(env.plinthMat, wx(sxPos, 0), py, wz(sxPos, 0), parT, parH, l - parT * 2, yaw);
      batch.addBox(env.metalFlashMat, wx(0, fzPos), h + parH + 0.02, wz(0, fzPos), w + 0.08, 0.04, parT + 0.08, yaw);
      batch.addBox(env.metalFlashMat, wx(sxPos, 0), h + parH + 0.02, wz(sxPos, 0), parT + 0.08, 0.04, l - parT * 2, yaw);
    }
  }

  // 5. Надстройки на плоской крыше: лифтовая шахта (машинное отделение) и вентиляционные стояки
  const longAlongZ = l >= w;
  if (w >= 8 && l >= 8 && h >= 8) {
    if (h >= 12) {
      const liftW = Math.min(3.6, w * 0.28);
      const liftL = Math.min(3.8, l * 0.28);
      const liftH = 2.05;
      const ox = (rand() - 0.5) * (w - liftW - 2.4) * 0.5;
      const oz = (rand() - 0.5) * (l - liftL - 2.4) * 0.5;
      const lwx = wx(ox, oz);
      const lwz = wz(ox, oz);
      batch.addBox(env.corniceMat, lwx, h + liftH * 0.5, lwz, liftW, liftH, liftL, yaw);
      batch.addBox(env.roofMat, lwx, h + liftH + 0.06, lwz, liftW + 0.22, 0.12, liftL + 0.22, yaw);
    }

    const ventCount = Math.min(3, Math.max(1, Math.floor(Math.max(w, l) / 11)));
    for (let vi = 0; vi < ventCount; vi++) {
      const pos = ((vi + 0.5) / ventCount - 0.5) * (Math.max(w, l) * 0.65);
      const lx = longAlongZ ? w * 0.16 : pos;
      const lz = longAlongZ ? pos : l * 0.16;
      const vwx = wx(lx, lz);
      const vwz = wz(lx, lz);
      batch.addBox(env.corniceMat, vwx, h + 0.575, vwz, 0.95, 1.15, 0.55, yaw);
      batch.addBox(env.metalFlashMat, vwx, h + 1.24, vwz, 1.12, 0.08, 0.72, yaw);
    }
  }

  // 6. Подъезд с металлической дверью и бетонным козырьком + застеклённые лоджии (строго выше 3.6 м)
  const facadeSpan = longAlongZ ? l : w;
  const halfDepth = (longAlongZ ? w : l) * 0.5;

  if (facadeSpan >= 11 && h >= 6.5) {
    const entrances = style === "panel" || style === "brick" ? Math.min(3, Math.max(1, Math.floor(facadeSpan / 15))) : 1;
    const doorYaw = longAlongZ ? yaw + Math.PI * 0.5 : yaw;
    for (let ei = 0; ei < entrances; ei++) {
      const along = ((ei + 0.5) / entrances - 0.5) * (facadeSpan * 0.68);
      const dlx = longAlongZ ? halfDepth + 0.03 : along;
      const dlz = longAlongZ ? along : halfDepth + 0.03;
      const clx = longAlongZ ? halfDepth + 0.24 : along;
      const clz = longAlongZ ? along : halfDepth + 0.24;
      batch.addBox(env.doorMat, wx(dlx, dlz), 1.15, wz(dlx, dlz), 1.35, 2.25, 0.08, doorYaw);
      batch.addBox(env.corniceMat, wx(clx, clz), 2.48, wz(clx, clz), 2.1, 0.13, 0.55, doorYaw, { keepBottom: true });
    }
  }

  if ((style === "panel" || style === "brick") && facadeSpan >= 12 && h >= 10.5) {
    const cols = Math.min(4, Math.max(2, Math.floor(facadeSpan / 8)));
    const floors = Math.min(6, Math.floor((h - 3.6) / 3.1));
    const stackH = floors * 3.05 - 0.35;
    if (stackH >= 2.2) {
      const balW = 2.55;
      const balD = 0.34;
      const baseY = 3.65 + stackH * 0.5;
      const asx = longAlongZ ? balD : balW;
      const asz = longAlongZ ? balW : balD;
      const gsx = longAlongZ ? balD + 0.03 : balW - 0.18;
      const gsz = longAlongZ ? balW - 0.18 : balD + 0.03;
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const along = ((cIdx + 0.5) / cols - 0.5) * (facadeSpan * 0.76);
        for (const side of [-1, 1]) {
          const blx = longAlongZ ? side * (halfDepth + balD * 0.45) : along;
          const blz = longAlongZ ? along : side * (halfDepth + balD * 0.45);
          const bwx = wx(blx, blz);
          const bwz = wz(blx, blz);
          batch.addBox(env.balconyFrameMat, bwx, baseY, bwz, asx, stackH, asz, yaw, { keepBottom: true });
          batch.addBox(env.balconyGlassMat, bwx, baseY + 0.08, bwz, gsx, stackH - 0.3, gsz, yaw);
        }
      }
    }
  }
}

/**
 * Пакетно записывает реалистичное дерево РФ/СНГ (липа/клён, берёза с белой берестой или 4-ярусная ель)
 * с развилкой ветвей и приствольной лункой прямо в пространственный чанк (0 отдельных `THREE.Mesh` на дерево).
 */
export function emitRealisticTree(
  chunks: SpatialChunkBatcher,
  x: number,
  z: number,
  height: number,
  env: CityEnvironmentPack,
  idHint = ""
): void {
  const seed = hashString(`${idHint}:${Math.round(x * 10)}:${Math.round(z * 10)}`);
  const rand = makeRng(seed);
  const yaw = rand() * Math.PI * 2;
  const syaw = Math.sin(yaw);
  const cyaw = Math.cos(yaw);
  const h = Math.max(3.2, height * (0.94 + rand() * 0.22));
  const kindRoll = seed % 9;
  const isSpruce = kindRoll === 0;
  const isBirch = kindRoll === 1 || kindRoll === 2;
  const pg = env.protoGeos;

  const batch = chunks.at(x, z, h * 0.45);

  // Приствольная лунка с тёмным грунтом и каменным кольцом
  batch.addProto(env.apronMat, pg.pitRing, x, 0.022, z, 0, 0, 0, 1, 1, 1);
  batch.addProto(env.soilMat, pg.soilDisc, x, 0.021, z, 0, 0, 0, 1, 1, 1);

  if (isSpruce) {
    batch.addProto(env.barkMat, pg.trunk, x, h * 0.175, z, 0, yaw, 0, 0.17, h * 0.35, 0.17, true);
    const tiers: Array<[number, number, number]> = [
      [0.34, 0.36, 0.38],
      [0.52, 0.3, 0.34],
      [0.69, 0.23, 0.3],
      [0.84, 0.15, 0.26],
    ];
    for (const [fy, fr, fh] of tiers) {
      batch.addProto(env.spruceMat, pg.spruceCone, x, h * fy, z, 0, yaw, 0, h * fr, h * fh, h * fr, true, true);
    }
    return;
  }

  const trunkMat = isBirch ? env.birchMat : env.barkMat;
  const trunkH = h * (isBirch ? 0.54 : 0.45);
  const baseR = isBirch ? 0.14 : 0.2;
  batch.addProto(trunkMat, pg.trunk, x, trunkH * 0.5, z, 0, yaw, 0, baseR, trunkH, baseR, true);

  for (const sgn of [-1, 1]) {
    const lx = sgn * 0.22;
    const lz = sgn * 0.06;
    batch.addProto(
      trunkMat,
      pg.limb,
      x + lx * cyaw + lz * syaw,
      trunkH * 0.9,
      z - lx * syaw + lz * cyaw,
      0,
      yaw,
      sgn * 0.52,
      0.08,
      trunkH * 0.42,
      0.08,
      false,
      false,
      "YXZ"
    );
  }

  // Многоярусная живая крона из 4 объёмов с естественной игрой оттенков листвы
  const baseR2 = h * (isBirch ? 0.25 : 0.3);
  const baseMatIdx = seed % env.foliageMats.length;
  const puffs: Array<[number, number, number, number, number, number, boolean]> = [
    [0, trunkH + baseR2 * 0.55, 0, baseR2 * 1.06, 0.88, 0, true],
    [-baseR2 * 0.48, trunkH + baseR2 * 0.38, baseR2 * 0.26, baseR2 * 0.78, 0.86, 1, false],
    [baseR2 * 0.46, trunkH + baseR2 * 0.44, -baseR2 * 0.28, baseR2 * 0.8, 0.9, 1, false],
    [baseR2 * 0.06, trunkH + baseR2 * 1.12, baseR2 * 0.05, baseR2 * 0.74, isBirch ? 1.15 : 0.92, 2, true],
  ];
  for (const [px, py, pz, r, sy, shadeStep, casts] of puffs) {
    const mat = env.foliageMats[(baseMatIdx + shadeStep) % env.foliageMats.length];
    batch.addProto(
      mat,
      pg.foliagePuff,
      x + px * cyaw + pz * syaw,
      py,
      z - px * syaw + pz * cyaw,
      0,
      yaw + shadeStep * 0.7,
      0,
      r,
      r * sy,
      r * 0.96,
      casts,
      true
    );
  }
}
