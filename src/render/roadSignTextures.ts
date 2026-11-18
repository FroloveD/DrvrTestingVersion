/**
 * @module render/roadSignTextures
 * @layer three-render
 * @role Процедурная генерация Canvas-текстур для всех 12 классов дорожных знаков (100 % офлайн, без внешних изображений).
 * @invariants #8 (офлайн — ноль внешних ассетов), #16 (учебная визуализация знаков).
 * @tests Смоук O (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { RoadSignDef } from "../sim/types";

function drawRoundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function drawDirectionalCircle(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fillStyle = "#ffffff";
  g.fill();
  g.beginPath();
  g.arc(64, 64, 53, 0, Math.PI * 2);
  g.fillStyle = "#1d4ed8";
  g.fill();
}

/** Создаёт процедурную текстуру лицевой стороны дорожного знака 128×128 px (sRGB). */
export function makeRoadSignTexture(sign: RoadSignDef): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);

  switch (sign.kind) {
    case "speed_limit": {
      const val = String(sign.limitKmh ?? 40);
      g.beginPath();
      g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fillStyle = "#ffffff";
      g.fill();
      g.lineWidth = 14;
      g.strokeStyle = "#dc2626";
      g.stroke();
      g.fillStyle = "#0f172a";
      g.font = val.length >= 3 ? "800 42px sans-serif" : "800 54px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(val, 64, 67);
      break;
    }

    case "stop": {
      const r = 59;
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 8) + (i * Math.PI) / 4;
        const px = 64 + Math.cos(a) * r;
        const py = 64 + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = "#dc2626";
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = "#ffffff";
      g.stroke();
      g.fillStyle = "#ffffff";
      g.font = "900 34px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("STOP", 64, 66);
      break;
    }

    case "give_way": {
      // Перевёрнутый белый треугольник с широкой красной каймой
      g.beginPath();
      g.moveTo(10, 18);
      g.lineTo(118, 18);
      g.lineTo(64, 116);
      g.closePath();
      g.fillStyle = "#ffffff";
      g.fill();
      g.lineWidth = 13;
      g.lineJoin = "round";
      g.strokeStyle = "#dc2626";
      g.stroke();
      break;
    }

    case "main_road": {
      // Белый ромб с жёлтой серединой (2.1)
      g.save();
      g.translate(64, 64);
      g.rotate(Math.PI / 4);
      g.fillStyle = "#ffffff";
      g.fillRect(-42, -42, 84, 84);
      g.strokeStyle = "#1e293b";
      g.lineWidth = 3;
      g.strokeRect(-42, -42, 84, 84);
      g.fillStyle = "#facc15";
      g.fillRect(-28, -28, 56, 56);
      g.strokeStyle = "#1e293b";
      g.lineWidth = 2;
      g.strokeRect(-28, -28, 56, 56);
      g.restore();
      break;
    }

    case "crosswalk": {
      // Синий квадрат 5.19 с белым треугольником и фигурой пешехода
      drawRoundRect(g, 8, 8, 112, 112, 12);
      g.fillStyle = "#ffffff";
      g.fill();
      drawRoundRect(g, 13, 13, 102, 102, 9);
      g.fillStyle = "#1d4ed8";
      g.fill();
      g.beginPath();
      g.moveTo(64, 22);
      g.lineTo(108, 102);
      g.lineTo(20, 102);
      g.closePath();
      g.fillStyle = "#ffffff";
      g.fill();
      // Силуэт пешехода и зебра
      g.fillStyle = "#0f172a";
      g.beginPath();
      g.arc(64, 48, 6.5, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 6;
      g.lineCap = "round";
      g.strokeStyle = "#0f172a";
      g.beginPath();
      g.moveTo(64, 56);
      g.lineTo(62, 74);
      g.moveTo(63, 60);
      g.lineTo(52, 70);
      g.moveTo(63, 60);
      g.lineTo(75, 69);
      g.moveTo(62, 74);
      g.lineTo(53, 91);
      g.moveTo(62, 74);
      g.lineTo(73, 91);
      g.stroke();
      for (const sx of [34, 48, 62, 76, 88]) {
        g.fillRect(sx, 95, 7, 4);
      }
      break;
    }

    case "no_stopping": {
      // Синий круг с красной каймой и красным крестом (3.27)
      g.beginPath();
      g.arc(64, 64, 57, 0, Math.PI * 2);
      g.fillStyle = "#1d4ed8";
      g.fill();
      g.lineWidth = 13;
      g.strokeStyle = "#dc2626";
      g.stroke();
      g.lineWidth = 12;
      g.strokeStyle = "#dc2626";
      g.beginPath();
      g.moveTo(27, 27);
      g.lineTo(101, 101);
      g.moveTo(101, 27);
      g.lineTo(27, 101);
      g.stroke();
      break;
    }

    case "no_entry": {
      // Красный круг с белым горизонтальным «кирпичом» (3.1)
      g.beginPath();
      g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fillStyle = "#ffffff";
      g.fill();
      g.beginPath();
      g.arc(64, 64, 53, 0, Math.PI * 2);
      g.fillStyle = "#dc2626";
      g.fill();
      drawRoundRect(g, 22, 50, 84, 28, 4);
      g.fillStyle = "#ffffff";
      g.fill();
      break;
    }

    case "parking": {
      // Синий квадрат с белой буквой P (6.4)
      drawRoundRect(g, 8, 8, 112, 112, 12);
      g.fillStyle = "#ffffff";
      g.fill();
      drawRoundRect(g, 13, 13, 102, 102, 9);
      g.fillStyle = "#1d4ed8";
      g.fill();
      g.fillStyle = "#ffffff";
      g.font = "900 78px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("P", 64, 69);
      break;
    }

    case "ahead_only": {
      drawDirectionalCircle(g);
      g.strokeStyle = "#ffffff";
      g.fillStyle = "#ffffff";
      g.lineWidth = 13;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(64, 100);
      g.lineTo(64, 38);
      g.stroke();
      g.beginPath();
      g.moveTo(64, 20);
      g.lineTo(42, 48);
      g.lineTo(86, 48);
      g.closePath();
      g.fill();
      break;
    }

    case "turn_right":
    case "turn_left": {
      drawDirectionalCircle(g);
      const dir = sign.kind === "turn_right" ? 1 : -1;
      g.strokeStyle = "#ffffff";
      g.fillStyle = "#ffffff";
      g.lineWidth = 13;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.beginPath();
      g.moveTo(64 - dir * 18, 98);
      g.lineTo(64 - dir * 18, 56);
      g.lineTo(64 + dir * 24, 56);
      g.stroke();
      g.beginPath();
      g.moveTo(64 + dir * 44, 56);
      g.lineTo(64 + dir * 18, 36);
      g.lineTo(64 + dir * 18, 76);
      g.closePath();
      g.fill();
      break;
    }

    case "living_zone": {
      // Синий прямоугольник 5.21 «Жилая зона» с домом и пометкой 20
      drawRoundRect(g, 8, 12, 112, 104, 12);
      g.fillStyle = "#ffffff";
      g.fill();
      drawRoundRect(g, 13, 17, 102, 94, 9);
      g.fillStyle = "#1d4ed8";
      g.fill();
      // Силуэт дома слева и подпись 20 справа
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.moveTo(22, 54);
      g.lineTo(42, 34);
      g.lineTo(62, 54);
      g.closePath();
      g.fill();
      g.fillRect(27, 54, 30, 34);
      g.fillStyle = "#1d4ed8";
      g.fillRect(37, 66, 10, 22);
      g.fillStyle = "#ffffff";
      g.font = "900 32px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(sign.limitKmh ?? 20), 86, 56);
      g.font = "700 14px sans-serif";
      g.fillText("ЖИЛАЯ", 74, 96);
      break;
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
