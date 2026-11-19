/**
 * @module render/roadSignTextures
 * @layer three-render
 * @role Процедурная генерация Canvas-текстур дорожных знаков по ГОСТ Р 52290-2004 (256×256, световозвращающая плёнка, щит 5.19.1/5.19.2, табличка 6.16 «СТОП», 100 % офлайн).
 * @invariants #8 (офлайн — ноль внешних ассетов), #16 (учебная визуализация знаков).
 * @tests Смоук O (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { RoadSignDef, RoadSignKind } from "../sim/types";

/** Геометрическая форма подложки знака по ГОСТ Р 52290-2004 (для точного тыльного щита). */
export type SignBackplateForm =
  | "circle"
  | "octagon"
  | "triangle_down"
  | "diamond"
  | "square"
  | "shield_519"
  | "rect_living";

export function getSignBackplateForm(kind: RoadSignKind): SignBackplateForm {
  switch (kind) {
    case "speed_limit":
    case "no_stopping":
    case "no_entry":
    case "ahead_only":
    case "turn_right":
    case "turn_left":
      return "circle";
    case "stop":
      return "octagon";
    case "give_way":
      return "triangle_down";
    case "main_road":
      return "diamond";
    case "crosswalk":
      return "shield_519";
    case "living_zone":
      return "rect_living";
    case "parking":
      return "square";
  }
}

function drawRoundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/** Лёгкий диагональный микропризматический блик световозвращающей плёнки типа Б/В (поверх заливки знака). */
function applyRetroreflectiveSheen(g: CanvasRenderingContext2D, size: number): void {
  g.save();
  g.globalCompositeOperation = "source-atop";
  const sheen = g.createLinearGradient(0, 0, size, size);
  sheen.addColorStop(0, "rgba(255,255,255,0.16)");
  sheen.addColorStop(0.38, "rgba(255,255,255,0.03)");
  sheen.addColorStop(0.54, "rgba(255,255,255,0.12)");
  sheen.addColorStop(0.75, "rgba(15,23,42,0.05)");
  sheen.addColorStop(1, "rgba(15,23,42,0.11)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, size, size);

  // Тонкая сетка микропризм (шаг 16 px)
  g.strokeStyle = "rgba(255,255,255,0.055)";
  g.lineWidth = 1;
  g.beginPath();
  for (let d = -size; d < size * 2; d += 16) {
    g.moveTo(d, 0);
    g.lineTo(d + size, size);
    g.moveTo(d + size, 0);
    g.lineTo(d, size);
  }
  g.stroke();
  g.restore();
}

function finalizeSignTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** База круглого предписывающего знака 4.1.* (белая отбортовка + синий ГОСТ #0b4ea2). */
function drawGostBlueCircle(g: CanvasRenderingContext2D): void {
  // Наружная белая кромка с тонкой штампованной фаской
  g.beginPath();
  g.arc(128, 128, 118, 0, Math.PI * 2);
  g.fillStyle = "#f8fafc";
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "#475569";
  g.stroke();

  g.beginPath();
  g.arc(128, 128, 108, 0, Math.PI * 2);
  g.fillStyle = "#0b4ea2";
  g.fill();
}

/** База круглого запрещающего знака 3.24 (белая отбортовка + широкая красная кайма ГОСТ #d41e24 + белое поле). */
function drawGostSpeedBase(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(128, 128, 119, 0, Math.PI * 2);
  g.fillStyle = "#f8fafc";
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "#475569";
  g.stroke();

  g.beginPath();
  g.arc(128, 128, 113, 0, Math.PI * 2);
  g.fillStyle = "#d41e24";
  g.fill();

  g.beginPath();
  g.arc(128, 128, 86, 0, Math.PI * 2);
  g.fillStyle = "#fbfdff";
  g.fill();
}

/** Рисует знак 5.19.1 / 5.19.2 «Пешеходный переход» на флуоресцентном жёлто-зелёном щите ГОСТ РФ. */
function drawGostCrosswalk519(g: CanvasRenderingContext2D, mirrorPedestrian: boolean): void {
  // Жёлто-зелёный флуоресцентный щит повышенной заметности (повсеместный стандарт в городах РФ)
  drawRoundRect(g, 6, 6, 244, 244, 22);
  g.fillStyle = "#c9ee1c";
  g.fill();
  g.lineWidth = 3.5;
  g.strokeStyle = "#3f4d10";
  g.stroke();

  // Внутренняя чёрно-серая тонкая рамка и белая отбортовка самого знака 5.19
  drawRoundRect(g, 26, 26, 204, 204, 18);
  g.fillStyle = "#f8fafc";
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = "#334155";
  g.stroke();

  // Синее поле ГОСТ 5.19
  drawRoundRect(g, 34, 34, 188, 188, 13);
  g.fillStyle = "#0b4ea2";
  g.fill();

  // Белый равнобедренный треугольник со скруглёнными углами
  g.beginPath();
  g.moveTo(128, 48);
  g.lineTo(208, 204);
  g.lineTo(48, 204);
  g.closePath();
  g.fillStyle = "#fbfdff";
  g.fill();
  g.lineJoin = "round";
  g.lineWidth = 6;
  g.strokeStyle = "#fbfdff";
  g.stroke();

  g.save();
  if (mirrorPedestrian) {
    g.translate(256, 0);
    g.scale(-1, 1);
  }

  // Полосы «зебры» в перспективе внизу треугольника
  g.fillStyle = "#0f172a";
  const stripes: Array<[number, number, number, number]> = [
    [66, 198, 76, 182],
    [88, 198, 95, 182],
    [110, 198, 114, 182],
    [134, 198, 134, 182],
    [157, 198, 153, 182],
    [179, 198, 172, 182],
  ];
  for (const [bx, by, tx, ty] of stripes) {
    g.beginPath();
    g.moveTo(bx - 6, by);
    g.lineTo(bx + 6, by);
    g.lineTo(tx + 4.5, ty);
    g.lineTo(tx - 4.5, ty);
    g.closePath();
    g.fill();
  }

  // Силуэт идущего пешехода по ГОСТ 5.19.1 (идёт влево)
  g.beginPath();
  g.arc(125, 98, 11.5, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = "#0f172a";
  g.lineCap = "round";
  g.lineJoin = "round";
  // Торс
  g.lineWidth = 14;
  g.beginPath();
  g.moveTo(126, 115);
  g.lineTo(124, 145);
  g.stroke();
  // Руки
  g.lineWidth = 9.5;
  g.beginPath();
  g.moveTo(124, 118);
  g.lineTo(106, 136);
  g.lineTo(100, 146);
  g.moveTo(127, 119);
  g.lineTo(144, 134);
  g.lineTo(151, 145);
  g.stroke();
  // Ноги (широкий шаг над зеброй)
  g.lineWidth = 11;
  g.beginPath();
  g.moveTo(122, 146);
  g.lineTo(108, 168);
  g.lineTo(101, 185);
  g.moveTo(127, 146);
  g.lineTo(141, 169);
  g.lineTo(151, 185);
  g.stroke();

  g.restore();
}

/** Создаёт процедурную текстуру знака 5.19.1 (справа) или 5.19.2 (слева) на флуоресцентном щите ГОСТ. */
export function makeCrosswalkSignTexture(mirror = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 256, 256);
  drawGostCrosswalk519(g, mirror);
  applyRetroreflectiveSheen(g, 256);
  return finalizeSignTexture(c);
}

/** Создаёт процедурную текстуру знака 3.24 «Ограничение максимальной скорости» по ГОСТ (256×256). */
export function makeGostSpeedLimitTexture(limitKmh: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 256, 256);
  drawGostSpeedBase(g);
  const val = String(Math.round(limitKmh));
  g.fillStyle = "#0f172a";
  g.font = val.length >= 3 ? "900 78px system-ui, sans-serif" : "900 102px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(val, 128, 133);
  applyRetroreflectiveSheen(g, 256);
  return finalizeSignTexture(c);
}

/** Создаёт процедурную текстуру таблички 6.16 «Стоп-линия» («СТОП») для опоры светофора. */
export function makeStopPlaqueTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const g = c.getContext("2d")!;
  drawRoundRect(g, 3, 3, 250, 90, 12);
  g.fillStyle = "#f8fafc";
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = "#0f172a";
  g.stroke();
  g.fillStyle = "#0f172a";
  g.font = "900 58px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("СТОП", 128, 51);
  applyRetroreflectiveSheen(g, 256);
  return finalizeSignTexture(c);
}

/** Создаёт процедурную текстуру лицевой стороны дорожного знака 256×256 px по ГОСТ Р 52290-2004 (sRGB). */
export function makeRoadSignTexture(sign: RoadSignDef): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 256, 256);

  switch (sign.kind) {
    case "speed_limit": {
      drawGostSpeedBase(g);
      const val = String(sign.limitKmh ?? 40);
      g.fillStyle = "#0f172a";
      g.font = val.length >= 3 ? "900 78px system-ui, sans-serif" : "900 102px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(val, 128, 133);
      break;
    }

    case "stop": {
      // Восьмиугольник 2.5 «Движение без остановки запрещено» с двойной белой/красной кромкой
      const poly = (r: number) => {
        g.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = Math.PI / 8 + (i * Math.PI) / 4;
          const px = 128 + Math.cos(a) * r;
          const py = 128 + Math.sin(a) * r;
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
      };
      poly(121);
      g.fillStyle = "#f8fafc";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = "#475569";
      g.stroke();

      poly(111);
      g.fillStyle = "#d41e24";
      g.fill();

      g.fillStyle = "#fbfdff";
      g.font = "900 68px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("STOP", 128, 132);
      break;
    }

    case "give_way": {
      // Знак 2.4 «Уступите дорогу»: перевёрнутый треугольник с белой кромкой и широкой красной каймой
      g.lineJoin = "round";
      g.beginPath();
      g.moveTo(22, 34);
      g.lineTo(234, 34);
      g.lineTo(128, 226);
      g.closePath();
      g.fillStyle = "#f8fafc";
      g.fill();
      g.lineWidth = 18;
      g.strokeStyle = "#f8fafc";
      g.stroke();

      g.beginPath();
      g.moveTo(28, 39);
      g.lineTo(228, 39);
      g.lineTo(128, 219);
      g.closePath();
      g.fillStyle = "#fbfdff";
      g.fill();
      g.lineWidth = 25;
      g.strokeStyle = "#d41e24";
      g.stroke();
      break;
    }

    case "main_road": {
      // Знак 2.1 «Главная дорога»: белый ромб с чёрной окантовкой и жёлтым внутренним квадратом ГОСТ
      g.save();
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      drawRoundRect(g, -85, -85, 170, 170, 11);
      g.fillStyle = "#fbfdff";
      g.fill();
      g.lineWidth = 4.5;
      g.strokeStyle = "#1e293b";
      g.stroke();

      drawRoundRect(g, -56, -56, 112, 112, 5);
      g.fillStyle = "#ffcf00";
      g.fill();
      g.lineWidth = 3.5;
      g.strokeStyle = "#1e293b";
      g.stroke();
      g.restore();
      break;
    }

    case "crosswalk": {
      drawGostCrosswalk519(g, false);
      break;
    }

    case "no_stopping": {
      // Знак 3.27 «Остановка запрещена»: синий круг, белая тонкая отбортовка креста и каймы по ГОСТ, красный крест
      g.beginPath();
      g.arc(128, 128, 119, 0, Math.PI * 2);
      g.fillStyle = "#f8fafc";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = "#475569";
      g.stroke();

      g.beginPath();
      g.arc(128, 128, 113, 0, Math.PI * 2);
      g.fillStyle = "#d41e24";
      g.fill();

      g.beginPath();
      g.arc(128, 128, 89, 0, Math.PI * 2);
      g.fillStyle = "#f8fafc";
      g.fill();

      g.beginPath();
      g.arc(128, 128, 84, 0, Math.PI * 2);
      g.fillStyle = "#0b4ea2";
      g.fill();

      // Белая окантовка диагонального креста + сам красный крест
      g.save();
      g.beginPath();
      g.arc(128, 128, 92, 0, Math.PI * 2);
      g.clip();
      g.strokeStyle = "#f8fafc";
      g.lineWidth = 28;
      g.beginPath();
      g.moveTo(48, 48);
      g.lineTo(208, 208);
      g.moveTo(208, 48);
      g.lineTo(48, 208);
      g.stroke();

      g.strokeStyle = "#d41e24";
      g.lineWidth = 21;
      g.beginPath();
      g.moveTo(48, 48);
      g.lineTo(208, 208);
      g.moveTo(208, 48);
      g.lineTo(48, 208);
      g.stroke();
      g.restore();
      break;
    }

    case "no_entry": {
      // Знак 3.1 «Въезд запрещён» («кирпич»)
      g.beginPath();
      g.arc(128, 128, 119, 0, Math.PI * 2);
      g.fillStyle = "#f8fafc";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = "#475569";
      g.stroke();

      g.beginPath();
      g.arc(128, 128, 110, 0, Math.PI * 2);
      g.fillStyle = "#d41e24";
      g.fill();

      drawRoundRect(g, 42, 100, 172, 56, 7);
      g.fillStyle = "#fbfdff";
      g.fill();
      break;
    }

    case "parking": {
      // Знак 6.4 «Парковка (парковочное место)»
      drawRoundRect(g, 14, 14, 228, 228, 22);
      g.fillStyle = "#f8fafc";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = "#475569";
      g.stroke();

      drawRoundRect(g, 25, 25, 206, 206, 15);
      g.fillStyle = "#0b4ea2";
      g.fill();

      g.fillStyle = "#fbfdff";
      g.font = "900 158px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("P", 130, 138);
      break;
    }

    case "ahead_only": {
      // Знак 4.1.1 «Движение прямо»
      drawGostBlueCircle(g);
      g.fillStyle = "#fbfdff";
      // Древко стрелы
      g.fillRect(114, 92, 28, 120);
      // Наконечник стрелы ГОСТ
      g.beginPath();
      g.moveTo(128, 36);
      g.lineTo(80, 104);
      g.lineTo(176, 104);
      g.closePath();
      g.fill();
      break;
    }

    case "turn_right":
    case "turn_left": {
      // Знаки 4.1.2 «Движение направо» / 4.1.3 «Движение налево» с плавным коленом ГОСТ
      drawGostBlueCircle(g);
      const dir = sign.kind === "turn_right" ? 1 : -1;
      g.strokeStyle = "#fbfdff";
      g.fillStyle = "#fbfdff";
      g.lineWidth = 27;
      g.lineCap = "butt";
      g.lineJoin = "round";
      g.beginPath();
      g.moveTo(128 - dir * 34, 206);
      g.lineTo(128 - dir * 34, 124);
      g.quadraticCurveTo(128 - dir * 34, 104, 128 - dir * 12, 104);
      g.lineTo(128 + dir * 44, 104);
      g.stroke();

      g.beginPath();
      g.moveTo(128 + dir * 94, 104);
      g.lineTo(128 + dir * 34, 60);
      g.lineTo(128 + dir * 34, 148);
      g.closePath();
      g.fill();
      break;
    }

    case "living_zone": {
      // Знак 5.21 «Жилая зона»: синий прямоугольник с домом, взрослым, играющим ребёнком, авто и меткой скорости
      drawRoundRect(g, 12, 22, 232, 212, 20);
      g.fillStyle = "#f8fafc";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = "#475569";
      g.stroke();

      drawRoundRect(g, 22, 32, 212, 192, 14);
      g.fillStyle = "#0b4ea2";
      g.fill();

      // Белая линия двора/дорожки
      g.fillStyle = "#fbfdff";
      g.beginPath();
      g.moveTo(30, 196);
      g.lineTo(224, 196);
      g.lineTo(224, 204);
      g.lineTo(30, 204);
      g.closePath();
      g.fill();

      // Силуэт дома слева
      g.beginPath();
      g.moveTo(36, 102);
      g.lineTo(74, 66);
      g.lineTo(112, 102);
      g.closePath();
      g.fill();
      g.fillRect(45, 100, 58, 76);
      g.fillStyle = "#0b4ea2";
      g.fillRect(55, 114, 16, 18);
      g.fillRect(77, 134, 17, 42);

      // Силуэт легкового автомобиля справа сзади
      g.fillStyle = "#fbfdff";
      drawRoundRect(g, 148, 86, 68, 24, 6);
      g.fill();
      g.beginPath();
      g.moveTo(158, 88);
      g.lineTo(166, 70);
      g.lineTo(198, 70);
      g.lineTo(206, 88);
      g.closePath();
      g.fill();
      g.fillStyle = "#0b4ea2";
      g.fillRect(167, 74, 30, 11);
      g.fillStyle = "#fbfdff";
      g.fillRect(154, 110, 11, 8);
      g.fillRect(199, 110, 11, 8);

      // Фигура играющего ребёнка и мяч в центре
      g.beginPath();
      g.arc(136, 134, 8, 0, Math.PI * 2);
      g.arc(116, 178, 6.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#fbfdff";
      g.lineWidth = 8;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(136, 144);
      g.lineTo(134, 166);
      g.moveTo(134, 150);
      g.lineTo(121, 160);
      g.moveTo(136, 150);
      g.lineTo(149, 158);
      g.moveTo(133, 166);
      g.lineTo(125, 186);
      g.moveTo(136, 166);
      g.lineTo(147, 185);
      g.stroke();

      // Чёткая учебная плашка лимита (20 км/ч) в правом нижнем углу
      drawRoundRect(g, 164, 142, 54, 42, 8);
      g.fillStyle = "#fbfdff";
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = "#d41e24";
      g.stroke();
      g.fillStyle = "#0f172a";
      g.font = "900 26px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(sign.limitKmh ?? 20), 191, 164);
      break;
    }
  }

  applyRetroreflectiveSheen(g, 256);
  return finalizeSignTexture(c);
}
