/**
 * @module render/cockpitDisplays
 * @layer three-render
 * @role Живые процедурные 3D-дисплеи салона Kia Ceed JD: приборная панель Supervision (тахометр, спидометр, БК, контрольные лампы), 7" ШГУ (навигатор маршрута / ассистент парковки, знак 3.24) и динамическая разметка камеры заднего вида R.
 * @invariants #1 (+X лево, +h поворот влево), #2 (лампы поворотников синхронны с simTime), #8 (100 % офлайн Canvas2D), #13 (0 перерисовок в покое — детерминизм зеркал).
 * @tests Смоук A, L, M, O (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { Gear, SimState, WorldData } from "../sim/types";
import { clamp } from "../sim/vehicle";

export type ClusterSnapshot = {
  engineOn: boolean;
  speedKmh: number;
  rpm: number;
  gearLabel: string;
  gearKind: Gear;
  speedLimitKmh: number;
  leftLit: boolean;
  rightLit: boolean;
  handbrake: boolean;
  belt: boolean;
  lights: boolean;
  inLineCross: boolean;
  inContact: boolean;
  distKm: number;
  // Навигация / парковочный ассистент на 7" ШГУ
  hasCheckpoint: boolean;
  cpRelAngle: number;
  cpDistM: number;
  cpRequireStop: boolean;
  cpFinalPark: boolean;
  cpIndex: number;
  cpTotal: number;
  cpHint: string;
  activeBayId: number | null;
  holdTime: number;
  finished: boolean;
  steerNorm: number; // -1..+1 (+ влево)
};

function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Вычисляет действующее ограничение скорости (км/ч) в текущей точке автомобиля. */
export function resolveActiveSpeedLimit(state: SimState, world: WorldData): number {
  let limit = world.defaultSpeedLimitKmh || 60;
  for (let i = 0; i < world.speedZones.length; i++) {
    const sz = world.speedZones[i];
    const dx = state.x - sz.x;
    const dz = state.z - sz.z;
    if (dx * dx + dz * dz <= sz.radius * sz.radius) {
      limit = Math.min(limit, sz.limitKmh);
    }
  }
  return Math.round(limit);
}

/** Контроллер живых CanvasTexture салона с dirty-кешем (0 мс в покое и вне камеры «Салон»). */
export class CockpitDisplayController {
  readonly clusterTex: THREE.CanvasTexture;
  readonly headUnitTex: THREE.CanvasTexture;
  readonly rearOverlayTex: THREE.CanvasTexture;

  private readonly clusterCanvas: HTMLCanvasElement;
  private readonly clusterCtx: CanvasRenderingContext2D;
  private readonly headCanvas: HTMLCanvasElement;
  private readonly headCtx: CanvasRenderingContext2D;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;

  private lastClusterKey = "";
  private lastHeadKey = "";
  private lastOverlayKey = "";

  constructor() {
    this.clusterCanvas = document.createElement("canvas");
    this.clusterCanvas.width = 512;
    this.clusterCanvas.height = 192;
    this.clusterCtx = this.clusterCanvas.getContext("2d")!;
    this.clusterTex = new THREE.CanvasTexture(this.clusterCanvas);
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;

    this.headCanvas = document.createElement("canvas");
    this.headCanvas.width = 384;
    this.headCanvas.height = 224;
    this.headCtx = this.headCanvas.getContext("2d")!;
    this.headUnitTex = new THREE.CanvasTexture(this.headCanvas);
    this.headUnitTex.colorSpace = THREE.SRGBColorSpace;

    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.width = 384;
    this.overlayCanvas.height = 224;
    this.overlayCtx = this.overlayCanvas.getContext("2d")!;
    this.rearOverlayTex = new THREE.CanvasTexture(this.overlayCanvas);
    this.rearOverlayTex.colorSpace = THREE.SRGBColorSpace;

    // Начальное состояние холодного старта (инвариант №5: ДВС выкл, P, ручник затянут, ремень снят)
    const cold: ClusterSnapshot = {
      engineOn: false,
      speedKmh: 0,
      rpm: 0,
      gearLabel: "P",
      gearKind: "P",
      speedLimitKmh: 60,
      leftLit: false,
      rightLit: false,
      handbrake: true,
      belt: false,
      lights: false,
      inLineCross: false,
      inContact: false,
      distKm: 0,
      hasCheckpoint: false,
      cpRelAngle: 0,
      cpDistM: 0,
      cpRequireStop: false,
      cpFinalPark: false,
      cpIndex: 0,
      cpTotal: 0,
      cpHint: "",
      activeBayId: null,
      holdTime: 0,
      finished: false,
      steerNorm: 0,
    };
    this.drawCluster(cold);
    this.drawHeadUnit(cold);
    this.drawRearOverlay(0, false);
  }

  /** Обновляет 3D-приборы и ШГУ при реальном изменении показаний. */
  update(state: SimState, world: WorldData, leftLit: boolean, rightLit: boolean): void {
    const speedKmh = Math.abs(state.v) * 3.6;
    const speedQ = Math.round(speedKmh);
    const rpmQ = state.engineOn ? Math.round(state.rpm / 50) * 50 : 0;
    const limit = resolveActiveSpeedLimit(state, world);
    const gearLabel = state.gear === "D" && state.engineOn ? `D${clamp(state.autoSubGear || 1, 1, 5)}` : state.gear;
    const distQ = Math.floor((state.distanceTraveled || 0) / 10) / 100; // шаг 0.01 км

    const cp = world.checkpoints[state.currentCheckpointIndex];
    const hasCp = Boolean(cp) && !state.finished;
    let cpRelAngle = 0;
    let cpDistM = 0;
    if (cp) {
      const dx = cp.x - state.x;
      const dz = cp.z - state.z;
      cpDistM = Math.round(Math.hypot(dx, dz));
      cpRelAngle = wrapAngle(Math.atan2(dx, dz) - state.h);
    }
    const steerNorm = clamp(state.swDeg / 540, -1, 1);

    const clusterKey = `${state.engineOn ? 1 : 0}|${speedQ}|${rpmQ}|${gearLabel}|${limit}|${leftLit ? 1 : 0}|${rightLit ? 1 : 0}|${state.handbrake ? 1 : 0}|${state.belt ? 1 : 0}|${state.lights ? 1 : 0}|${distQ.toFixed(2)}`;
    const inReverseCam = state.engineOn && state.gear === "R";

    let snap: ClusterSnapshot | undefined;
    const ensureSnap = (): ClusterSnapshot => {
      if (snap) return snap;
      const built: ClusterSnapshot = {
        engineOn: state.engineOn,
        speedKmh: speedQ,
        rpm: rpmQ,
        gearLabel,
        gearKind: state.gear,
        speedLimitKmh: limit,
        leftLit,
        rightLit,
        handbrake: state.handbrake,
        belt: state.belt,
        lights: state.lights,
        inLineCross: state.inLineCross,
        inContact: state.inContact,
        distKm: distQ,
        hasCheckpoint: hasCp,
        cpRelAngle,
        cpDistM,
        cpRequireStop: Boolean(cp?.requireStop),
        cpFinalPark: Boolean(cp?.isFinalPark),
        cpIndex: state.currentCheckpointIndex + 1,
        cpTotal: world.checkpoints.length,
        cpHint: cp?.instruction ?? "",
        activeBayId: state.activeBayId,
        holdTime: state.holdTime,
        finished: state.finished,
        steerNorm,
      };
      snap = built;
      return built;
    };

    if (clusterKey !== this.lastClusterKey) {
      this.lastClusterKey = clusterKey;
      this.drawCluster(ensureSnap());
      this.clusterTex.needsUpdate = true;
    }

    if (inReverseCam) {
      const steerStep = Math.round(steerNorm * 24);
      const warn = state.inLineCross || state.inContact;
      const ovKey = `${steerStep}|${warn ? 1 : 0}`;
      if (ovKey !== this.lastOverlayKey) {
        this.lastOverlayKey = ovKey;
        this.drawRearOverlay(steerStep / 24, warn);
        this.rearOverlayTex.needsUpdate = true;
      }
    } else {
      const angStep = Math.round(cpRelAngle * 10);
      const distStep = cpDistM > 50 ? Math.round(cpDistM / 5) * 5 : cpDistM;
      const holdStep = Math.round(state.holdTime * 5);
      const headKey = `${state.engineOn ? 1 : 0}|${gearLabel}|${speedQ}|${limit}|${hasCp ? 1 : 0}|${state.currentCheckpointIndex}|${angStep}|${distStep}|${state.activeBayId ?? -1}|${holdStep}|${state.inLineCross ? 1 : 0}|${state.inContact ? 1 : 0}|${state.finished ? 1 : 0}|${state.lights ? 1 : 0}`;
      if (headKey !== this.lastHeadKey) {
        this.lastHeadKey = headKey;
        this.drawHeadUnit(ensureSnap());
        this.headUnitTex.needsUpdate = true;
      }
    }
  }

  private drawCluster(s: ClusterSnapshot): void {
    const g = this.clusterCtx;
    const w = 512;
    const h = 192;
    g.fillStyle = "#070b10";
    g.fillRect(0, 0, w, h);

    const litAlpha = s.engineOn ? 1 : 0.34;
    const startA = Math.PI * 0.76;
    const sweepA = Math.PI * 1.48;

    const drawGauge = (
      cx: number,
      cy: number,
      r: number,
      maxVal: number,
      majorCount: number,
      value: number,
      unit: string,
      redFromFrac: number,
      limitFrac?: number
    ) => {
      // Хромированный колодец Supervision и матовый антрацитовый циферблат
      const ring = g.createRadialGradient(cx, cy, r - 6, cx, cy, r + 6);
      ring.addColorStop(0, "#1e293b");
      ring.addColorStop(0.55, s.engineOn ? "#94a3b8" : "#475569");
      ring.addColorStop(1, "#0f172a");
      g.fillStyle = ring;
      g.beginPath();
      g.arc(cx, cy, r + 5, 0, Math.PI * 2);
      g.fill();

      const face = g.createRadialGradient(cx, cy - 10, 6, cx, cy, r);
      face.addColorStop(0, s.engineOn ? "#131c28" : "#0b1017");
      face.addColorStop(1, "#070a0f");
      g.fillStyle = face;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();

      // Красная дуга отсечки тахометра или отметка активного ограничения скорости
      if (redFromFrac < 1) {
        g.strokeStyle = `rgba(239,68,68,${0.85 * litAlpha})`;
        g.lineWidth = 4;
        g.beginPath();
        g.arc(cx, cy, r - 6, startA + sweepA * redFromFrac, startA + sweepA);
        g.stroke();
      }
      if (limitFrac !== undefined && s.engineOn) {
        const la = startA + sweepA * clamp(limitFrac, 0, 1);
        g.strokeStyle = s.speedKmh > s.speedLimitKmh + 1 ? "#ff3b3b" : "#f59e0b";
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(cx + Math.cos(la) * (r - 17), cy + Math.sin(la) * (r - 17));
        g.lineTo(cx + Math.cos(la) * (r - 2), cy + Math.sin(la) * (r - 2));
        g.stroke();
      }

      // Деления и оцифровка
      const totalSub = majorCount * 2;
      for (let i = 0; i <= totalSub; i++) {
        const frac = i / totalSub;
        const a = startA + frac * sweepA;
        const isMaj = i % 2 === 0;
        const isRed = frac >= redFromFrac - 0.001;
        g.strokeStyle = isRed
          ? `rgba(248,113,113,${litAlpha})`
          : `rgba(241,245,249,${(isMaj ? 0.96 : 0.5) * litAlpha})`;
        g.lineWidth = isMaj ? 2.6 : 1.3;
        const inR = isMaj ? r - 13 : r - 8;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * inR, cy + Math.sin(a) * inR);
        g.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3));
        g.stroke();

        if (isMaj) {
          const num = Math.round((i / 2) * (maxVal / majorCount));
          // На спидометре подписываем через одно крупное деление для идеальной читаемости
          if (maxVal <= 10 || (i / 2) % 2 === 0) {
            g.fillStyle = isRed ? `rgba(248,113,113,${litAlpha})` : `rgba(226,232,240,${litAlpha})`;
            g.font = "700 11px system-ui, sans-serif";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(String(num), cx + Math.cos(a) * (r - 24), cy + Math.sin(a) * (r - 24));
          }
        }
      }

      g.fillStyle = `rgba(148,163,184,${0.85 * litAlpha})`;
      g.font = "600 9.5px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(unit, cx, cy + r * 0.54);

      // Светящаяся красная стрелка Kia Supervision
      const na = startA + clamp(value / maxVal, 0, 1) * sweepA;
      g.save();
      g.strokeStyle = s.engineOn ? "#ff4d2e" : "#7c2d12";
      g.lineWidth = 3.4;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(cx - Math.cos(na) * 11, cy - Math.sin(na) * 11);
      g.lineTo(cx + Math.cos(na) * (r - 11), cy + Math.sin(na) * (r - 11));
      g.stroke();
      g.restore();

      g.fillStyle = "#1f2937";
      g.beginPath();
      g.arc(cx, cy, 8.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#94a3b8";
      g.lineWidth = 1.6;
      g.stroke();
    };

    // Левый колодец — тахометр (0..7 ×1000 об/мин), правый — спидометр (0..200 км/ч)
    drawGauge(102, 102, 74, 7, 7, s.rpm / 1000, "×1000 об/мин", 6 / 7);
    drawGauge(410, 102, 74, 200, 10, s.speedKmh, "км/ч", 1.1, s.speedLimitKmh / 200);

    // Верхняя панель контрольных ламп (поворотники ◀ ▶, ручник (P), ремень, ближний свет)
    const drawTurnArrow = (x: number, y: number, dir: -1 | 1, lit: boolean) => {
      g.fillStyle = lit ? "#22c55e" : "#12261c";
      g.beginPath();
      g.moveTo(x + dir * 13, y);
      g.lineTo(x + dir * 2, y - 9);
      g.lineTo(x + dir * 2, y - 4);
      g.lineTo(x - dir * 10, y - 4);
      g.lineTo(x - dir * 10, y + 4);
      g.lineTo(x + dir * 2, y + 4);
      g.lineTo(x + dir * 2, y + 9);
      g.closePath();
      g.fill();
    };
    // В координатах щитка слева — левый поворотник (+X), справа — правый (-X)
    drawTurnArrow(196, 22, -1, s.leftLit);
    drawTurnArrow(316, 22, 1, s.rightLit);

    // Лампа стояночного тормоза (P)
    g.strokeStyle = s.handbrake ? "#ef4444" : "#2a1619";
    g.fillStyle = s.handbrake ? "#ef4444" : "#2a1619";
    g.lineWidth = 1.8;
    g.beginPath();
    g.arc(227, 22, 8.5, 0, Math.PI * 2);
    g.stroke();
    g.font = "800 10px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("P", 227, 22.5);

    // Лампа непристёгнутого ремня безопасности
    const beltWarn = !s.belt;
    g.fillStyle = beltWarn ? "#ef4444" : "#2a1619";
    g.strokeStyle = beltWarn ? "#ef4444" : "#2a1619";
    g.beginPath();
    g.arc(256, 16, 3.2, 0, Math.PI * 2);
    g.fill();
    g.fillRect(251.5, 20.5, 9, 9);
    g.strokeStyle = beltWarn ? "#070b10" : "#111827";
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(251, 21);
    g.lineTo(261, 29);
    g.stroke();

    // Лампа ближнего света фар
    const hlOn = s.lights && s.engineOn;
    g.fillStyle = hlOn ? "#22c55e" : "#13241b";
    g.strokeStyle = hlOn ? "#22c55e" : "#13241b";
    g.beginPath();
    g.arc(285, 22, 5.5, -Math.PI * 0.5, Math.PI * 0.5);
    g.closePath();
    g.fill();
    g.lineWidth = 1.5;
    for (const dy of [-3.5, 0, 3.5]) {
      g.beginPath();
      g.moveTo(276, 23 + dy);
      g.lineTo(282, 21 + dy);
      g.stroke();
    }

    // Центральный цветной TFT-дисплей борткомпьютера Supervision
    const bx = 192;
    const by = 40;
    const bw = 128;
    const bh = 132;
    g.fillStyle = s.engineOn ? "#0d1724" : "#080d14";
    g.fillRect(bx, by, bw, bh);
    g.strokeStyle = s.engineOn ? "#263a52" : "#151e29";
    g.lineWidth = 1.5;
    g.strokeRect(bx, by, bw, bh);

    // Крупный индикатор передачи АКПП (P, R, N, D1..D5, L/1)
    const gearBg =
      s.gearKind === "R"
        ? "#991b1b"
        : s.gearKind === "D" || s.gearKind === "1"
          ? "#0f766e"
          : s.gearKind === "N"
            ? "#92400e"
            : "#1e293b";
    g.fillStyle = s.engineOn ? gearBg : "#161f2c";
    g.fillRect(bx + 8, by + 7, 46, 26);
    g.fillStyle = s.engineOn ? "#f8fafc" : "#64748b";
    g.font = "900 18px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(s.gearLabel, bx + 31, by + 20.5);

    // Мини-знак 3.24 ограничения скорости в углу БК
    const sx = bx + bw - 22;
    const sy = by + 20;
    g.fillStyle = "#f8fafc";
    g.beginPath();
    g.arc(sx, sy, 13, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#dc2626";
    g.lineWidth = 3.2;
    g.stroke();
    g.fillStyle = "#0f172a";
    g.font = "900 11px system-ui, sans-serif";
    g.fillText(String(s.speedLimitKmh), sx, sy + 0.5);

    if (s.engineOn) {
      const over = s.speedKmh > s.speedLimitKmh + 1;
      g.fillStyle = over ? "#ff5c5c" : "#f8fafc";
      g.font = "900 36px system-ui, sans-serif";
      g.fillText(String(s.speedKmh), bx + bw * 0.5, by + 64);
      g.fillStyle = "#94a3b8";
      g.font = "700 10px system-ui, sans-serif";
      g.fillText("КМ/Ч", bx + bw * 0.5, by + 87);

      // Шкала температуры ОЖ 90°C и пробег заезда
      g.fillStyle = "#1e293b";
      g.fillRect(bx + 10, by + 101, bw - 20, 5);
      g.fillStyle = "#38bdf8";
      g.fillRect(bx + 10, by + 101, (bw - 20) * 0.52, 5);
      g.fillStyle = "#cbd5e1";
      g.font = "700 10.5px system-ui, sans-serif";
      g.fillText(`90°C  ·  ${s.distKm.toFixed(2)} км`, bx + bw * 0.5, by + 119);
    } else {
      g.fillStyle = "#94a3b8";
      g.font = "800 12px system-ui, sans-serif";
      g.fillText("ДВС ЗАГЛУШЕН", bx + bw * 0.5, by + 64);
      g.fillStyle = "#f5b942";
      g.font = "700 11px system-ui, sans-serif";
      g.fillText("ПУСК: F (P/N)", bx + bw * 0.5, by + 86);
    }
  }

  private drawHeadUnit(s: ClusterSnapshot): void {
    const g = this.headCtx;
    const w = 384;
    const h = 224;
    g.fillStyle = s.engineOn ? "#0b1320" : "#06090e";
    g.fillRect(0, 0, w, h);

    if (!s.engineOn) {
      // Режим ожидания ШГУ Kia с мягкими часами и логотипом
      g.strokeStyle = "#1e293b";
      g.lineWidth = 2;
      g.strokeRect(10, 10, w - 20, h - 20);
      g.fillStyle = "#64748b";
      g.font = "800 22px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("KIA  ·  УЧЕБНЫЙ", w * 0.5, h * 0.45);
      g.fillStyle = "#475569";
      g.font = "600 13px system-ui, sans-serif";
      g.fillText("Запустите двигатель (F)", w * 0.5, h * 0.62);
      return;
    }

    // Верхняя строка статуса ШГУ
    g.fillStyle = "#121f33";
    g.fillRect(0, 0, w, 34);
    g.fillStyle = "#52d6bd";
    g.font = "800 13px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(s.hasCheckpoint ? "НАВИГАЦИЯ МАРШРУТА" : "АССИСТЕНТ МАНЁВРА", 14, 17);
    g.fillStyle = "#e2e8f0";
    g.textAlign = "right";
    g.fillText(`${s.gearLabel}  ·  ${s.speedKmh} км/ч`, w - 14, 17);

    // Левая карточка — знак ГОСТ 3.24 и контроль скорости
    const over = s.speedKmh > s.speedLimitKmh + 1;
    g.fillStyle = over ? "#3b1117" : "#111c2d";
    g.fillRect(12, 46, 122, 164);
    g.strokeStyle = over ? "#ef4444" : "#22344d";
    g.lineWidth = 2;
    g.strokeRect(12, 46, 122, 164);

    const cx = 73;
    const cy = 108;
    g.fillStyle = "#f8fafc";
    g.beginPath();
    g.arc(cx, cy, 40, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#dc2626";
    g.lineWidth = 9;
    g.stroke();
    g.fillStyle = "#0f172a";
    g.font = "900 30px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(String(s.speedLimitKmh), cx, cy + 1);
    g.fillStyle = over ? "#fca5a5" : "#94a3b8";
    g.font = "700 12px system-ui, sans-serif";
    g.fillText(over ? "ПРЕВЫШЕНИЕ!" : "ЛИМИТ КМ/Ч", cx, 182);

    // Правая карточка — стрелка до КТ маршрута либо схема парковочного бокса
    const rx = 146;
    const rw = w - rx - 12;
    g.fillStyle = "#111c2d";
    g.fillRect(rx, 46, rw, 164);
    g.strokeStyle = "#22344d";
    g.lineWidth = 2;
    g.strokeRect(rx, 46, rw, 164);

    const midX = rx + rw * 0.5;
    if (s.finished) {
      g.fillStyle = "#52d6bd";
      g.font = "900 20px system-ui, sans-serif";
      g.fillText("ЗАЕЗД ЗАВЕРШЁН", midX, 114);
      g.fillStyle = "#cbd5e1";
      g.font = "600 13px system-ui, sans-serif";
      g.fillText("Поставьте P и ручник", midX, 148);
    } else if (s.hasCheckpoint) {
      // Живая поворотная стрелка курса к активной контрольной точке (+cpRelAngle = влево -> против ЧС)
      const ax = rx + 54;
      const ay = 108;
      g.save();
      g.translate(ax, ay);
      g.rotate(-s.cpRelAngle);
      g.fillStyle = s.cpFinalPark ? "#52d6bd" : s.cpRequireStop ? "#f87171" : "#f5b942";
      g.beginPath();
      g.moveTo(0, -32);
      g.lineTo(24, 14);
      g.lineTo(8, 8);
      g.lineTo(8, 30);
      g.lineTo(-8, 30);
      g.lineTo(-8, 8);
      g.lineTo(-24, 14);
      g.closePath();
      g.fill();
      g.restore();

      g.textAlign = "left";
      g.fillStyle = "#f8fafc";
      g.font = "900 28px system-ui, sans-serif";
      g.fillText(`${s.cpDistM} м`, rx + 96, 96);
      g.fillStyle = "#94a3b8";
      g.font = "700 13px system-ui, sans-serif";
      g.fillText(`КТ ${s.cpIndex} из ${s.cpTotal}${s.cpRequireStop ? " · СТОП" : ""}`, rx + 96, 126);

      const hint = s.cpHint.length > 26 ? `${s.cpHint.slice(0, 25)}…` : s.cpHint;
      g.textAlign = "center";
      g.fillStyle = "#cbd5e1";
      g.font = "600 12.5px system-ui, sans-serif";
      g.fillText(hint || "Следуйте по маршруту", midX, 182);
    } else {
      // Режим автодрома: индикация бокса, контроля разметки и удержания остановки
      const alert = s.inContact || s.inLineCross;
      g.fillStyle = alert ? "#f87171" : s.holdTime > 0 ? "#52d6bd" : "#e2e8f0";
      g.font = "900 20px system-ui, sans-serif";
      const status = s.inContact
        ? "КАСАНИЕ!"
        : s.inLineCross
          ? "ЛИНИЯ РАЗМЕТКИ!"
          : s.activeBayId !== null
            ? `БОКС №${s.activeBayId}`
            : "ВЫБЕРИТЕ БОКС";
      g.fillText(status, midX, 98);

      g.fillStyle = "#94a3b8";
      g.font = "700 13px system-ui, sans-serif";
      g.fillText(
        s.holdTime > 0 ? `Фиксация: ${s.holdTime.toFixed(1)} с` : "R — камера заднего вида",
        midX,
        136
      );

      // Полоса прогресса удержания в боксе
      g.fillStyle = "#1e293b";
      g.fillRect(rx + 22, 166, rw - 44, 10);
      if (s.holdTime > 0) {
        g.fillStyle = "#52d6bd";
        g.fillRect(rx + 22, 166, (rw - 44) * clamp(s.holdTime / 1.2, 0, 1), 10);
      }
    }
  }

  /** Прозрачная сетка парковочных линий поверх живого GPU-изображения камеры заднего вида R. */
  private drawRearOverlay(steerNorm: number, warn: boolean): void {
    const g = this.overlayCtx;
    const w = 384;
    const h = 224;
    g.clearRect(0, 0, w, h);

    // Лёгкая виньетка по краям и плашка «R КАМЕРА»
    g.fillStyle = warn ? "rgba(185,28,28,0.78)" : "rgba(9,15,24,0.68)";
    g.fillRect(0, 0, w, 28);
    g.fillStyle = warn ? "#fef2f2" : "#52d6bd";
    g.font = "800 12.5px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(warn ? "▲ ВНИМАНИЕ: ГАБАРИТ / ЛИНИЯ" : "● R  КАМЕРА ЗАДНЕГО ВИДА", 12, 14);

    // Статическая трапеция габаритов (зелёная 2 м -> жёлтая 1 м -> красная 0.4 м)
    const drawStaticRail = (sign: -1 | 1) => {
      const pts = [
        { x: w * 0.5 + sign * 134, y: h - 10 },
        { x: w * 0.5 + sign * 108, y: h - 48 },
        { x: w * 0.5 + sign * 84, y: h - 84 },
        { x: w * 0.5 + sign * 64, y: h - 114 },
      ];
      const cols = ["#ef4444", "#f59e0b", "#22c55e"];
      for (let i = 0; i < 3; i++) {
        g.strokeStyle = cols[i];
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(pts[i].x, pts[i].y);
        g.lineTo(pts[i + 1].x, pts[i + 1].y);
        g.stroke();
      }
    };
    drawStaticRail(-1);
    drawStaticRail(1);

    // Поперечные риски дистанции
    for (const [y, halfW, col] of [
      [h - 48, 108, "rgba(239,68,68,0.85)"],
      [h - 84, 84, "rgba(245,158,11,0.75)"],
      [h - 114, 64, "rgba(34,197,94,0.7)"],
    ] as const) {
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(w * 0.5 - halfW, y);
      g.lineTo(w * 0.5 + halfW, y);
      g.stroke();
    }

    // Динамическая жёлтая траектория Аккермана (изгибается вслед за поворотом руля; +steerNorm = влево на экране)
    const bend = -steerNorm * 72;
    g.strokeStyle = "rgba(251,191,36,0.92)";
    g.lineWidth = 3.2;
    for (const sign of [-1, 1] as const) {
      const x0 = w * 0.5 + sign * 130;
      const y0 = h - 10;
      const xm = w * 0.5 + sign * 92 + bend * 0.42;
      const ym = h - 68;
      const x1 = w * 0.5 + sign * 62 + bend;
      const y1 = h - 116;
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo(xm, ym, x1, y1);
      g.stroke();
    }
    // Соединительная дуга дальней кромки
    g.beginPath();
    g.moveTo(w * 0.5 - 62 + bend, h - 116);
    g.lineTo(w * 0.5 + 62 + bend, h - 116);
    g.stroke();
  }

  dispose(): void {
    this.clusterTex.dispose();
    this.headUnitTex.dispose();
    this.rearOverlayTex.dispose();
  }
}
