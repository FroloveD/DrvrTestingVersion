/**
 * @module render/roadTextures
 * @layer three-render
 * @role Процедурные PBR-текстуры дорожной среды РФ/СНГ по ГОСТ (асфальт ЩМА + bump, накат полос, тротуарная плитка, бордюры БР 100.30.15, тактильная плитка, термопластик, стрела 1.18, люки, трафареты боксов, газон, LED-линзы).
 * @invariants #8 (100 % офлайн — ноль внешних ассетов и сетевых запросов).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";

/** Детерминированный генератор псевдослучайных чисел (одинаковый кадр на каждом запуске — инвариант зеркал L1). */
function makeRng(seedInit: number): () => number {
  let s = seedInit % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Создаёт плоскую геометрию `w × l` с мировым масштабом UV (без растяжения текстуры на длинных улицах). */
export function makeWorldUvPlane(w: number, l: number, tileU: number, tileV = tileU): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(w, l);
  const uv = geo.attributes.uv;
  if (uv) {
    const ru = w / Math.max(0.1, tileU);
    const rv = l / Math.max(0.1, tileV);
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * ru, uv.getY(i) * rv);
    }
    uv.needsUpdate = true;
  }
  return geo;
}

/** Создаёт круглую геометрию радиуса `r` с мировым масштабом UV (для бесшовных стыков асфальта и плитки). */
export function makeWorldUvCircle(r: number, segments: number, tileSize: number): THREE.CircleGeometry {
  const geo = new THREE.CircleGeometry(r, segments);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const inv = 1 / Math.max(0.1, tileSize);
  if (pos && uv) {
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, pos.getX(i) * inv, pos.getY(i) * inv);
    }
    uv.needsUpdate = true;
  }
  return geo;
}

/** Бесшовный асфальтобетон ЩМА-15 (256×256 albedo + bumpMap): минеральная крошка, тональные пятна и швы мастики. */
export function makeGostAsphaltMaps(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;

  const bc = document.createElement("canvas");
  bc.width = size;
  bc.height = size;
  const bg = bc.getContext("2d")!;

  g.fillStyle = "#2d333b";
  g.fillRect(0, 0, size, size);
  bg.fillStyle = "#808080";
  bg.fillRect(0, 0, size, size);

  const rand = makeRng(4109);

  // Мягкие крупномасштабные вариации оттенка полотна (с повторением через край тайла)
  for (let i = 0; i < 36; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 22 + rand() * 44;
    const dark = rand() < 0.55;
    const alpha = 0.035 + rand() * 0.045;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (x + ox + r < 0 || x + ox - r > size || y + oy + r < 0 || y + oy - r > size) continue;
        const gr = g.createRadialGradient(x + ox, y + oy, 2, x + ox, y + oy, r);
        gr.addColorStop(0, dark ? `rgba(18,22,28,${alpha})` : `rgba(88,96,108,${alpha})`);
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }

  // Минеральный щебень ЩМА (тёплый гранит + холодный базальт + светлый кварцит)
  for (let i = 0; i < 4800; i++) {
    const x = Math.floor(rand() * size);
    const y = Math.floor(rand() * size);
    const w = rand() < 0.72 ? 1 : 2;
    const v = 32 + Math.floor(rand() * 44);
    const warm = rand() < 0.35 ? 3 : 0;
    g.fillStyle = `rgb(${v + warm},${v + 2},${v + 6 - warm})`;
    g.fillRect(x, y, w, w);

    const bv = 90 + Math.floor(rand() * 82);
    bg.fillStyle = `rgb(${bv},${bv},${bv})`;
    bg.fillRect(x, y, w, w);
  }

  // Тонкие битумные швы санации микротрещин
  g.strokeStyle = "rgba(17, 20, 25, 0.36)";
  g.lineWidth = 1.2;
  for (let k = 0; k < 3; k++) {
    let cx = rand() * size;
    let cy = rand() * size;
    g.beginPath();
    g.moveTo(cx, cy);
    for (let s = 0; s < 7; s++) {
      cx += (rand() - 0.5) * 26;
      cy += 8 + rand() * 14;
      g.lineTo(cx, cy);
    }
    g.stroke();
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

/** Полупрозрачная декаль следов наката колёс на полосе движения (две мягкие колеи + тёмная середина). */
export function makeLaneWearTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);

  // Левая и правая колеи колёс (на расстоянии ~1.55 м при ширине полосы 3.3–3.75 м)
  for (const rx of [34, 94]) {
    const gr = g.createLinearGradient(rx - 22, 0, rx + 22, 0);
    gr.addColorStop(0, "rgba(12,15,20,0)");
    gr.addColorStop(0.5, "rgba(12,15,20,0.24)");
    gr.addColorStop(1, "rgba(12,15,20,0)");
    g.fillStyle = gr;
    g.fillRect(rx - 22, 0, 44, 128);
  }
  // Лёгкое масляное потемнение строго по оси полосы
  const mid = g.createLinearGradient(50, 0, 78, 0);
  mid.addColorStop(0, "rgba(10,12,16,0)");
  mid.addColorStop(0.5, "rgba(10,12,16,0.12)");
  mid.addColorStop(1, "rgba(10,12,16,0)");
  g.fillStyle = mid;
  g.fillRect(50, 0, 28, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Бесшовная вибропрессованная тротуарная плитка «брусчатка» (256×256 albedo + bumpMap). */
export function makeSidewalkPaverMaps(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;

  const bc = document.createElement("canvas");
  bc.width = size;
  bc.height = size;
  const bg = bc.getContext("2d")!;

  // Песчано-цементные швы между плитками
  g.fillStyle = "#525a63";
  g.fillRect(0, 0, size, size);
  bg.fillStyle = "#343434";
  bg.fillRect(0, 0, size, size);

  const rand = makeRng(7723);
  const rows = 16;
  const cols = 8;
  const rh = size / rows;
  const cw = size / cols;

  for (let r = 0; r < rows; r++) {
    const shift = (r % 2) * (cw * 0.5);
    for (let col = -1; col <= cols; col++) {
      const px = col * cw + shift;
      const py = r * rh;
      const base = 122 + Math.floor(rand() * 26);
      const warm = Math.floor((rand() - 0.45) * 8);
      g.fillStyle = `rgb(${base + warm},${base + 2},${base + 5 - warm})`;
      g.fillRect(px + 1.5, py + 1.5, cw - 3, rh - 3);
      // Тонкая светлая фаска по верхнему краю кирпичика
      g.fillStyle = "rgba(255,255,255,0.09)";
      g.fillRect(px + 2, py + 1.5, cw - 4, 1.5);

      const bv = 185 + Math.floor(rand() * 35);
      bg.fillStyle = `rgb(${bv},${bv},${bv})`;
      bg.fillRect(px + 2, py + 2, cw - 4, rh - 4);
    }
  }

  // Микрозерно бетона поверх плитки
  for (let i = 0; i < 1600; i++) {
    const shade = rand() < 0.5 ? "rgba(30,36,42,0.08)" : "rgba(240,244,248,0.07)";
    g.fillStyle = shade;
    g.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 2, 2);
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

/** Текстура бордюрного камня БР 100.30.15 по ГОСТ: чёрно-белая покраска или натуральный бетон со швами. */
export function makeGostCurbTexture(blackAndWhite: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  const rand = makeRng(blackAndWhite ? 9011 : 9029);

  if (blackAndWhite) {
    // Два метровых камня: белый побелённый + чёрный матовый с растворным швом
    g.fillStyle = "#e9eef3";
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = "#1d232b";
    g.fillRect(128, 0, 128, 64);
    // Растворные швы
    g.fillStyle = "#64707d";
    g.fillRect(0, 0, 3, 64);
    g.fillRect(126, 0, 4, 64);
  } else {
    g.fillStyle = "#9aa3ad";
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = "#929ba5";
    g.fillRect(128, 0, 128, 64);
    // Метровые швы между блоками БР 100.30.15
    g.fillStyle = "#5b646e";
    g.fillRect(0, 0, 4, 64);
    g.fillRect(126, 0, 4, 64);
  }

  // Лёгкое дорожное запыление нижней кромки и фактура бетона
  const dirt = g.createLinearGradient(0, 38, 0, 64);
  dirt.addColorStop(0, "rgba(30,35,40,0)");
  dirt.addColorStop(1, "rgba(28,32,36,0.28)");
  g.fillStyle = dirt;
  g.fillRect(0, 38, 256, 26);

  for (let i = 0; i < 420; i++) {
    g.fillStyle = rand() < 0.5 ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)";
    g.fillRect(Math.floor(rand() * 256), Math.floor(rand() * 64), 2, 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Жёлтая рифлёная тактильная плитка ГОСТ Р 52875 на подходах к пешеходному переходу. */
export function makeTactilePavingTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#eab308";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#a16207";
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 125, 125);
  g.strokeRect(64, 0, 1, 128);
  g.strokeRect(0, 64, 128, 1);

  // Рельефные тактильные конусы
  for (let r = 0; r < 8; r++) {
    for (let col = 0; col < 8; col++) {
      const cx = col * 16 + 8;
      const cy = r * 16 + 8;
      g.fillStyle = "#fde047";
      g.beginPath();
      g.arc(cx - 1, cy - 1, 4.2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#b45309";
      g.beginPath();
      g.arc(cx + 1, cy + 1, 3.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Дорожный термопластик ГОСТ Р 51256 (белый или жёлтый для зебры 1.14.1) с лёгкой фактурой износа. */
export function makeThermoplasticTexture(yellow: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = yellow ? "#f4b918" : "#eff4f9";
  g.fillRect(0, 0, 128, 128);
  const rand = makeRng(yellow ? 5501 : 5507);
  for (let i = 0; i < 420; i++) {
    g.fillStyle =
      rand() < 0.58
        ? "rgba(45, 52, 62, 0.11)"
        : "rgba(255, 255, 255, 0.16)";
    g.fillRect(Math.floor(rand() * 128), Math.floor(rand() * 128), 2, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Вытянутая направляющая стрела 1.18 по ГОСТ Р 51256 (смотрит вверх холста → вдоль +Z полосы). */
export function makeGostArrow118Texture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 256);
  g.fillStyle = "rgba(241, 245, 249, 0.92)";
  // Древко
  g.fillRect(52, 92, 24, 150);
  // Вытянутый треугольный наконечник с обратной подсечкой по ГОСТ 1.18
  g.beginPath();
  g.moveTo(64, 12);
  g.lineTo(106, 108);
  g.lineTo(76, 96);
  g.lineTo(52, 96);
  g.lineTo(22, 108);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Чугунный смотровой люк ГОСТ 3634 с вафельным рельефом и обечайкой. */
export function makeManholeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  // Битумное кольцо вокруг обечайки
  g.beginPath();
  g.arc(64, 64, 60, 0, Math.PI * 2);
  g.fillStyle = "rgba(20, 24, 30, 0.72)";
  g.fill();
  // Чугунная крышка
  g.beginPath();
  g.arc(64, 64, 51, 0, Math.PI * 2);
  g.fillStyle = "#3f444a";
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = "#2b2f35";
  g.stroke();
  for (const r of [38, 24, 11]) {
    g.beginPath();
    g.arc(64, 64, r, 0, Math.PI * 2);
    g.lineWidth = 2.2;
    g.strokeStyle = "#525860";
    g.stroke();
  }
  g.strokeStyle = "#2f343a";
  g.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12);
    g.lineTo(64 + Math.cos(a) * 49, 64 + Math.sin(a) * 49);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Прилотковая чугунная дождеприёмная решётка ДБ по ГОСТ 3634. */
export function makeStormGrateTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2b3036";
  g.fillRect(0, 0, 64, 128);
  g.strokeStyle = "#4b525b";
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, 59, 123);
  g.fillStyle = "#111519";
  for (let y = 12; y <= 108; y += 12) {
    g.fillRect(10, y, 20, 7);
    g.fillRect(34, y, 20, 7);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Бесшовная текстура городского газона (256×256) вместо однотонной зелёной заливки. */
export function makeUrbanGrassTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3d5540";
  g.fillRect(0, 0, size, size);
  const rand = makeRng(3181);

  for (let i = 0; i < 42; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 18 + rand() * 38;
    const col = rand() < 0.5 ? "rgba(48,70,50,0.22)" : "rgba(78,96,64,0.18)";
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (x + ox + r < 0 || x + ox - r > size || y + oy + r < 0 || y + oy - r > size) continue;
        const gr = g.createRadialGradient(x + ox, y + oy, 2, x + ox, y + oy, r);
        gr.addColorStop(0, col);
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  for (let i = 0; i < 3600; i++) {
    const grn = 68 + Math.floor(rand() * 34);
    const red = Math.floor(grn * (0.66 + rand() * 0.14));
    const blu = Math.floor(grn * 0.68);
    g.fillStyle = `rgb(${red},${grn},${blu})`;
    g.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 1, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Мягкий радиальный ореол (halo) вокруг включённой LED-секции светофора. */
export function makeSignalHaloTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  gr.addColorStop(0, "rgba(255,255,255,0.62)");
  gr.addColorStop(0.45, "rgba(255,255,255,0.22)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Трафарет номера парковочного бокса и символа «P» по ГОСТ Р 51256 (1.24.4). */
export function makeGostBayStencilTexture(id: number, occupied: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 160;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 160, 160);
  const stroke = occupied ? "rgba(155, 168, 184, 0.58)" : "rgba(245, 222, 160, 0.9)";
  g.strokeStyle = stroke;
  g.lineWidth = 6;
  g.strokeRect(18, 18, 124, 124);
  // Трафаретные разрывы по серединам сторон рамки
  g.clearRect(72, 12, 16, 14);
  g.clearRect(72, 134, 16, 14);
  g.fillStyle = occupied ? "rgba(165, 178, 194, 0.65)" : "rgba(248, 250, 252, 0.92)";
  g.font = "900 66px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(id), 80, 84);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
