/**
 * @module render/vehiclesAndPeds
 * @layer three-render
 * @role Процедурные 3D-модели пяти Kia игрока и припаркованного автопарка (кузов, оптика, диски, салон, приборы), а также анимированных пешеходов.
 * @invariants #1 (координаты +Z вперёд, +X левый борт), #2 (левый руль +X, синхронные поворотники), #8 (офлайн), #13 (слои зеркал).
 * @tests Смоук A, L, M, O (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { ParkedModelKey } from "../sim/types";
import { HORN_PICK } from "../sim/cockpitLayout";
import { getPlayerCar } from "../sim/playerCar";
import { CAR, VEHICLE_DIMS } from "../sim/vehicle";

export type DetailedCarRig = {
  root: THREE.Group;
  chassis: THREE.Group;
  flPivot: THREE.Group;
  frPivot: THREE.Group;
  wheelMeshes: THREE.Object3D[];
  steerWheelMesh: THREE.Group;
  blinkLeftMats: THREE.MeshBasicMaterial[];
  blinkRightMats: THREE.MeshBasicMaterial[];
  brakeMat: THREE.MeshBasicMaterial;
  reverseMat: THREE.MeshBasicMaterial;
  headlightMat: THREE.MeshBasicMaterial;
  headSpotL?: THREE.SpotLight;
  headSpotR?: THREE.SpotLight;
  learnerSign?: THREE.Object3D;
  /** Физические зеркальные полотна Kia Ceed JD для прямого GPU-отражения в виде из салона. */
  rearMirrorGlass?: THREE.Mesh;
  leftMirrorGlass?: THREE.Mesh;
  rightMirrorGlass?: THREE.Mesh;
  /** Живой 7" экран ШГУ Kia Ceed JD (навигация/ассистент в P/N/D и живая камера заднего вида в R). */
  headUnitScreen?: THREE.Mesh;
  rearCamScreen?: THREE.Mesh;
  rearCamOverlay?: THREE.Mesh;
  /** Анимированные физические органы управления в салоне Kia Ceed JD (в т.ч. интерактивный рычаг 6АКПП Shiftronic). */
  gearLeverPivot?: THREE.Object3D;
  gearGateDot?: THREE.Mesh;
  gearGateDotMat?: THREE.MeshBasicMaterial;
  gearKnobCapMat?: THREE.MeshStandardMaterial;
  gearGateRimMat?: THREE.MeshStandardMaterial;
  /** Невидимые коллайдеры рычага и пазов кулисы (`lever`, `P`, `R`, `N`, `D`, `M`, `M+`, `M-`) для raycast в салоне. */
  shifterPickTargets?: THREE.Object3D[];
  /** Невидимые коллайдеры органов салона (ШГУ, ручки VOL/TUNE, подрулевой, аварийка, START/STOP, ручник) для raycast. */
  cockpitPickTargets?: THREE.Object3D[];
  headUnitKnobL?: THREE.Object3D;
  headUnitKnobR?: THREE.Object3D;
  headlightSwitchPivot?: THREE.Object3D;
  headlightSwitchMat?: THREE.MeshBasicMaterial;
  handbrakePivot?: THREE.Object3D;
  leftStalkPivot?: THREE.Object3D;
  hazardBtnMat?: THREE.MeshBasicMaterial;
  startBtnMat?: THREE.MeshBasicMaterial;
  brakePedalPivot?: THREE.Object3D;
  gasPedalPivot?: THREE.Object3D;
  seatbeltStrap?: THREE.Object3D;
  /** ДХО (DRL), конусы ближнего света и подсветка заднего госномера. */
  drlMat?: THREE.MeshBasicMaterial;
  plateLightMat?: THREE.MeshBasicMaterial;
  headlightBeamGroup?: THREE.Group;
  /** Силуэт водителя (виден снаружи, скрывается в режиме камеры из салона). */
  driverGroup?: THREE.Group;
};

/** Идентификатор зоны интерактивного 3D-селектора 6АКПП Shiftronic в салоне Kia Ceed JD. */
export type ShifterHitId = "lever" | "P" | "R" | "N" | "D" | "M" | "M+" | "M-";

/** Идентификатор органа управления в салоне Kia Ceed JD для raycast (ШГУ, подрулевой, аварийка, START/STOP, ручник). */
export type CockpitControlId =
  | "headunit"
  | "vol"
  | "tune"
  | "stalk-left"
  | "headlight"
  | "hazard"
  | "start"
  | "handbrake"
  | "horn";

/** Геометрия кулисы 6АКПП Shiftronic в локальных координатах кузова (`+X` к водителю, `+Z` вперёд). */
export const SHIFTER_LAYOUT = {
  gateX: 0.022,
  gateY: 0.545,
  gateOffsetZ: 0.44, // прибавляется к centerShiftZ = (frontOverhang - rearOverhang) * 0.5
  mainRailX: 0.032,
  manualRailX: 0.064,
  mainDotX: 0.006,
  manualDotX: 0.048,
  knobPlaneY: 0.655,
  offP: 0.058,
  offR: 0.022,
  offN: -0.014,
  offD: -0.05,
  offMPlus: -0.014,
  offMMinus: -0.08,
} as const;

/**
 * Текстура подсвеченной кулисы 6АКПП Shiftronic `P – R – N – D` + боковой ручной паз `+ / M / −`
 * на центральном тоннеле Kia Ceed JD (160×320; `u=0` слева — сторона водителя `+X`, `v=1` сверху — вперёд `+Z`).
 */
function makeShifterGateTextureRaw(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 320;
  const g = c.getContext("2d")!;

  // Рояльный чёрный лак с тонкой металлической окантовкой
  const bg = g.createLinearGradient(0, 0, 160, 320);
  bg.addColorStop(0, "#151c26");
  bg.addColorStop(0.5, "#0d1219");
  bg.addColorStop(1, "#18212d");
  g.fillStyle = bg;
  g.fillRect(0, 0, 160, 320);

  g.strokeStyle = "#94a3b8";
  g.lineWidth = 5;
  g.strokeRect(4, 4, 152, 312);
  g.strokeStyle = "rgba(255,255,255,0.12)";
  g.lineWidth = 1.5;
  g.strokeRect(10, 10, 140, 300);

  // Хромированная окантовка основной прорези P–R–N–D (x≈68) и ручного паза Shiftronic +/M/− слева к водителю (x≈28)
  g.strokeStyle = "#64748b";
  g.lineWidth = 22;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(68, 56);
  g.lineTo(68, 246);
  g.lineTo(28, 246);
  g.moveTo(28, 186);
  g.lineTo(28, 286);
  g.stroke();

  // Внутренняя тёмная прорезь кулисы со шторкой
  g.strokeStyle = "#04060a";
  g.lineWidth = 15;
  g.beginPath();
  g.moveTo(68, 56);
  g.lineTo(68, 246);
  g.lineTo(28, 246);
  g.moveTo(28, 186);
  g.lineTo(28, 286);
  g.stroke();

  // Тонкие риски фиксаторов P / R / N / D
  g.strokeStyle = "rgba(148,163,184,0.38)";
  g.lineWidth = 2;
  for (const y of [63, 123, 183, 243]) {
    g.beginPath();
    g.moveTo(82, y);
    g.lineTo(94, y);
    g.stroke();
  }

  // Подсвеченные символы P – R – N – D справа от основной прорези
  const labels: Array<[string, number, string]> = [
    ["P", 63, "#f1f5f9"],
    ["R", 123, "#ff6b6b"],
    ["N", 183, "#cbd5e1"],
    ["D", 243, "#52d6bd"],
  ];
  g.font = "900 32px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const [txt, y, col] of labels) {
    g.fillStyle = col;
    g.fillText(txt, 124, y);
  }

  // Подсветка ручного паза Shiftronic (+ / M / −) со стороны водителя
  g.fillStyle = "#f5b942";
  g.font = "900 26px system-ui, sans-serif";
  g.fillText("+", 28, 156);
  g.fillText("−", 28, 304);
  g.font = "800 17px system-ui, sans-serif";
  g.fillStyle = "#fcd34d";
  g.fillText("M", 49, 221);

  // Нижняя микроподпись SHIFTRONIC
  g.font = "700 11px system-ui, sans-serif";
  g.fillStyle = "#7c909d";
  g.fillText("SHIFT", 114, 294);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Текстура мягкого светового пятна ближнего света фар на дорожном полотне (128×256). */
function makeHeadlightBeamTextureRaw(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d")!;
  // v=0 (y=256) — у фары, v=1 (y=0) — затухание вдали
  const grad = g.createLinearGradient(0, 256, 0, 0);
  grad.addColorStop(0, "rgba(255,248,220,0.34)");
  grad.addColorStop(0.35, "rgba(255,246,214,0.18)");
  grad.addColorStop(0.75, "rgba(255,244,210,0.05)");
  grad.addColorStop(1, "rgba(255,244,210,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(48, 256);
  g.lineTo(80, 256);
  g.lineTo(126, 0);
  g.lineTo(2, 0);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Плоскость зеркального полотна с горизонтально отражёнными UV (`u' = 1 - u`) для честного зеркала без CPU-readback. */
function makeMirroredPlaneGeometry(width: number, height: number): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, height);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, 1 - uv.getX(i));
  }
  uv.needsUpdate = true;
  return geo;
}

export type DetailedPedestrianVisual = {
  crosswalkId: string;
  group: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
};

/** Текстура государственного регистрационного знака РФ по ГОСТ Р 50577 (256×56, флаг и регион 77 RUS). */
export function makeRussianLicensePlateTexture(text = "У 077 КС"): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 56;
  const g = c.getContext("2d")!;

  g.fillStyle = "#f8fafc";
  g.fillRect(0, 0, 256, 56);
  g.strokeStyle = "#111827";
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, 251, 51);
  // Разделитель секции региона
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(192, 3);
  g.lineTo(192, 53);
  g.stroke();

  g.fillStyle = "#0f172a";
  g.font = "900 32px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 96, 30);

  g.font = "900 22px system-ui, sans-serif";
  g.fillText("77", 222, 20);
  g.font = "800 11px system-ui, sans-serif";
  g.fillText("RUS", 213, 41);

  // Мини-триколор справа от RUS
  g.fillStyle = "#ffffff";
  g.fillRect(231, 34, 16, 4);
  g.fillStyle = "#1d4ed8";
  g.fillRect(231, 38, 16, 4);
  g.fillStyle = "#dc2626";
  g.fillRect(231, 42, 16, 4);
  g.strokeStyle = "#64748b";
  g.lineWidth = 0.8;
  g.strokeRect(231, 34, 16, 12);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Текстура комбинации приборов Kia Ceed JD Supervision (тахометр + борткомпьютер + спидометр) для вида из салона. */
export function makeInstrumentClusterTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "#090e14";
  g.fillRect(0, 0, 256, 96);

  const drawDial = (cx: number, cy: number, r: number, redFrom: number) => {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = "#64748b";
    g.lineWidth = 2.5;
    g.stroke();
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * 0.78 + (i / 10) * Math.PI * 1.44;
      g.strokeStyle = i >= redFrom ? "#ef4444" : "#e2e8f0";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
      g.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
      g.stroke();
    }
    // Красная стрелка Kia
    g.strokeStyle = "#f97316";
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx - r * 0.55, cy + r * 0.35);
    g.stroke();
  };

  drawDial(58, 52, 34, 8);
  drawDial(198, 52, 34, 11);

  // Экран бортового компьютера в центре
  g.fillStyle = "#112233";
  g.fillRect(104, 24, 48, 52);
  g.fillStyle = "#52d6bd";
  g.font = "700 13px monospace";
  g.textAlign = "center";
  g.fillText("CEED", 128, 44);
  g.fillStyle = "#94a3b8";
  g.font = "700 10px monospace";
  g.fillText("AUTO", 128, 62);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 5-спицевое колесо на легкосплавном диске с тормозным ротором и ступицей (чётко видно вращение). */
function createDetailedWheelMesh(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x191d22, roughness: 0.86 });
  const alloyMat = new THREE.MeshStandardMaterial({ color: 0xd4dce6, metalness: 0.65, roughness: 0.26 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.55, roughness: 0.42 });

  const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 22);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, tireMat);
  tire.castShadow = true;
  g.add(tire);

  // Утопленный тормозной диск
  const discGeo = new THREE.CylinderGeometry(radius * 0.56, radius * 0.56, width * 0.88, 16);
  discGeo.rotateZ(Math.PI / 2);
  g.add(new THREE.Mesh(discGeo, hubMat));

  // Наружный обод легкосплавного диска и 5 лучей
  const rimRingGeo = new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, width + 0.008, 18, 1, true);
  rimRingGeo.rotateZ(Math.PI / 2);
  g.add(new THREE.Mesh(rimRingGeo, alloyMat));

  const spokeGeo = new THREE.BoxGeometry(width + 0.018, radius * 0.6, 0.048);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    const sp = new THREE.Mesh(spokeGeo, alloyMat);
    sp.rotation.x = a;
    sp.position.set(0, Math.cos(a) * radius * 0.3, Math.sin(a) * radius * 0.3);
    g.add(sp);
  }

  const capGeo = new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, width + 0.026, 12);
  capGeo.rotateZ(Math.PI / 2);
  g.add(new THREE.Mesh(capGeo, hubMat));
  return g;
}

/**
 * Текстуры кулисы и светового пятна не зависят от машины, поэтому создаются один раз на вкладку:
 * парк из пяти машин не плодит по копии canvas-текстуры на каждый кадр (и GPU-память не утекает
 * при пересборке рига). Общая текстура освобождается вместе со сценой.
 */
let shifterGateTexCache: THREE.CanvasTexture | null = null;
let headlightBeamTexCache: THREE.CanvasTexture | null = null;

function makeShifterGateTexture(): THREE.CanvasTexture {
  if (!shifterGateTexCache) shifterGateTexCache = makeShifterGateTextureRaw();
  return shifterGateTexCache;
}

function makeHeadlightBeamTexture(): THREE.CanvasTexture {
  if (!headlightBeamTexCache) headlightBeamTexCache = makeHeadlightBeamTextureRaw();
  return headlightBeamTexCache;
}

/** Освобождает общие текстуры кулисы и лучей (вызывается при полном dispose сцены). */
export function disposeSharedVehicleTextures(): void {
  shifterGateTexCache?.dispose();
  headlightBeamTexCache?.dispose();
  shifterGateTexCache = null;
  headlightBeamTexCache = null;
}

/**
 * Строит детализированный автомобиль (`isPlayer = true` — машина игрока с полным салоном)
 * или припаркованный автомобиль автопарка.
 *
 * Для машины игрока `model` — это её паспортный ключ парка (Picanto, Rio, Ceed, XCeed, Sorento):
 * габариты кузова, база, колея, радиус колеса и предел выворота берутся из `sim/playerCar.ts`,
 * поэтому риг совпадает с физикой (столкновения, клиренс в боксе, кадр из салона).
 */
export function buildDetailedCar(
  model: ParkedModelKey,
  bodyColor: number,
  isPlayer: boolean,
  shadowTex: THREE.CanvasTexture,
  learnerTex: THREE.CanvasTexture,
  plateTex: THREE.CanvasTexture,
  clusterTex: THREE.CanvasTexture,
  mirrorHardwareLayer: number,
  cockpitTextures?: {
    headUnitTex: THREE.CanvasTexture;
    rearOverlayTex: THREE.CanvasTexture;
  }
): DetailedCarRig {
  // Машина игрока строится по своему паспорту парка, припаркованная — по прежним размерам модели
  const playerSpec = isPlayer ? getPlayerCar(model) : null;
  const dim = playerSpec
    ? {
        length: playerSpec.length,
        width: playerSpec.width,
        height: playerSpec.height,
        wheelbase: playerSpec.wheelbase,
      }
    : VEHICLE_DIMS[model];
  const L = dim.length;
  const W = dim.width;
  const H = dim.height;
  const wb = dim.wheelbase;
  const wr = isPlayer && playerSpec ? playerSpec.wheelRadius : model === "sorento" ? 0.35 : 0.3;
  const ww = isPlayer && playerSpec ? playerSpec.wheelWidth : 0.205;
  const frontOverhang = playerSpec ? playerSpec.frontOverhang : CAR.frontOverhang;
  const rearOverhang = playerSpec ? playerSpec.rearOverhang : CAR.rearOverhang;
  const centerShiftZ = isPlayer ? (frontOverhang - rearOverhang) / 2 : 0;

  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  // Мягкая контактная тень под кузовом
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.3, L * 1.2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.set(0, 0.02, centerShiftZ);
  root.add(shadowPlane);

  // Глянцевая автомобильная эмаль металлик (ловит блики 360°-неба и облаков из scene.environment без тяжёлого шейдера)
  const paintMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    metalness: isPlayer ? 0.54 : 0.48,
    roughness: isPlayer ? 0.18 : 0.24,
  });
  const darkTrimMat = new THREE.MeshStandardMaterial({ color: 0x1b2129, roughness: 0.68, metalness: 0.14 });
  const satinSilverMat = new THREE.MeshStandardMaterial({ color: 0xb8c4d0, metalness: 0.72, roughness: 0.28 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xe6edf5, metalness: 0.9, roughness: 0.12 });
  const plateMat = new THREE.MeshBasicMaterial({ map: plateTex });
  const glassMat = new THREE.MeshStandardMaterial({
    color: isPlayer ? 0xa6cce8 : 0x2b4158,
    transparent: true,
    opacity: isPlayer ? 0.22 : 0.76,
    roughness: 0.08,
    metalness: 0.45,
  });

  const isSuv = model === "sorento";
  const sillY = isSuv ? 0.3 : 0.24;
  const beltY = isSuv ? 0.96 : 0.84;
  const lowerH = beltY - sillY;
  const frontFaceZ = centerShiftZ + L / 2;
  const rearFaceZ = centerShiftZ - L / 2;

  // Светотехника
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xdbeafe });
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x7f1d1d });
  const reverseMat = new THREE.MeshBasicMaterial({ color: 0x334155 });
  const reflectorMat = new THREE.MeshBasicMaterial({ color: 0x991b1b });
  const blinkLeftMats: THREE.MeshBasicMaterial[] = [];
  const blinkRightMats: THREE.MeshBasicMaterial[] = [];
  const mirrorBezelMat = new THREE.MeshStandardMaterial({ color: 0x10151c, roughness: 0.62, metalness: 0.14 });
  const mirrorDefaultGlassMat = new THREE.MeshStandardMaterial({ color: 0x7d93a6, metalness: 0.88, roughness: 0.12 });
  const asphericLineMat = new THREE.MeshBasicMaterial({ color: 0x1e293b, transparent: true, opacity: 0.42 });
  let rearMirrorGlass: THREE.Mesh | undefined;
  let leftMirrorGlass: THREE.Mesh | undefined;
  let rightMirrorGlass: THREE.Mesh | undefined;
  let headUnitScreen: THREE.Mesh | undefined;
  let rearCamScreen: THREE.Mesh | undefined;
  let rearCamOverlay: THREE.Mesh | undefined;
  let gearLeverPivot: THREE.Object3D | undefined;
  let gearGateDot: THREE.Mesh | undefined;
  let gearGateDotMat: THREE.MeshBasicMaterial | undefined;
  let gearKnobCapMat: THREE.MeshStandardMaterial | undefined;
  let gearGateRimMat: THREE.MeshStandardMaterial | undefined;
  let shifterPickTargets: THREE.Object3D[] | undefined;
  let cockpitPickTargets: THREE.Object3D[] | undefined;
  let headUnitKnobL: THREE.Object3D | undefined;
  let headUnitKnobR: THREE.Object3D | undefined;
  let headlightSwitchPivot: THREE.Object3D | undefined;
  let headlightSwitchMat: THREE.MeshBasicMaterial | undefined;
  let handbrakePivot: THREE.Object3D | undefined;
  let leftStalkPivot: THREE.Object3D | undefined;
  let hazardBtnMat: THREE.MeshBasicMaterial | undefined;
  let startBtnMat: THREE.MeshBasicMaterial | undefined;
  let brakePedalPivot: THREE.Object3D | undefined;
  let gasPedalPivot: THREE.Object3D | undefined;
  let seatbeltStrap: THREE.Object3D | undefined;
  let drlMat: THREE.MeshBasicMaterial | undefined;
  let plateLightMat: THREE.MeshBasicMaterial | undefined;
  let headlightBeamGroup: THREE.Group | undefined;
  let driverGroup: THREE.Group | undefined;

  /** Назначает всем мешам узла зеркала выделенный слой, чтобы зеркала не рендерили сами себя. */
  const setMirrorLayer = (obj: THREE.Object3D) => {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) child.layers.set(mirrorHardwareLayer);
    });
  };

  if (isPlayer) {
    // Полый кузов Kia Ceed JD (инвариант №7: салон полый, водитель и кресла внутри, обзор назад чист)
    const wall = 0.095;
    const cabinLen = wb * 0.88;
    const hoodLen = (L - cabinLen) * 0.56;
    const trunkLen = L - cabinLen - hoodLen;

    // Днище и чёрные аэродинамические пороги
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W - 0.04, 0.08, L - 0.08), darkTrimMat);
    floor.position.set(0, sillY + 0.03, centerShiftZ);
    chassis.add(floor);

    for (const side of [1, -1] as const) {
      // Дверная панель + поясная выштамповка + ручки дверей + порог
      const door = new THREE.Mesh(new THREE.BoxGeometry(wall, lowerH - 0.05, cabinLen), paintMat);
      door.position.set(side * (W / 2 - wall / 2), sillY + 0.05 + (lowerH - 0.05) / 2, centerShiftZ - 0.06);
      door.castShadow = true;

      const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.075, wb - 0.55), darkTrimMat);
      rocker.position.set(side * (W / 2 - 0.02), sillY + 0.035, centerShiftZ);

      const crease = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, cabinLen * 0.92), paintMat);
      crease.position.set(side * (W / 2 + 0.004), beltY - 0.12, centerShiftZ - 0.06);

      // Передняя и задняя дверные ручки + чёрная центральная стойка B
      for (const hz of [0.12, -0.58]) {
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.032, 0.15), paintMat);
        handle.position.set(side * (W / 2 + 0.012), beltY - 0.1, centerShiftZ + hz);
        chassis.add(handle);
      }
      const bPillar = new THREE.Mesh(new THREE.BoxGeometry(0.04, H - beltY - 0.04, 0.11), darkTrimMat);
      bPillar.position.set(side * (W * 0.43), (beltY + H) / 2 - 0.02, centerShiftZ - 0.14);
      chassis.add(door, rocker, crease, bPillar);
    }

    // Передний модуль: объёмный бампер + покатый капот Kia Ceed
    const frontCore = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, lowerH * 0.84, hoodLen), paintMat);
    frontCore.position.set(0, sillY + lowerH * 0.42, frontFaceZ - hoodLen / 2);
    frontCore.castShadow = true;
    const hoodTop = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.08, hoodLen * 0.92), paintMat);
    hoodTop.position.set(0, beltY - 0.05, frontFaceZ - hoodLen * 0.52);
    hoodTop.rotation.x = 0.11;
    hoodTop.castShadow = true;
    const frontLip = new THREE.Mesh(new THREE.BoxGeometry(W - 0.04, 0.08, 0.24), darkTrimMat);
    frontLip.position.set(0, sillY + 0.02, frontFaceZ - 0.11);
    chassis.add(frontCore, hoodTop, frontLip);

    // Характерные продольные выштамповки капота Kia Ceed JD (видны из салона для точного чувства передних габаритов),
    // жабо лобового стекла, форсунки омывателя и бескаркасные дворники в зоне покоя
    for (const side of [1, -1] as const) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.026, hoodLen * 0.78), paintMat);
      rib.position.set(side * (W * 0.31), beltY + 0.002, frontFaceZ - hoodLen * 0.52);
      rib.rotation.x = 0.105;
      rib.rotation.y = -side * 0.055;
      const nozzle = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.014, 0.032), darkTrimMat);
      nozzle.position.set(side * 0.24, beltY + 0.038, frontFaceZ - hoodLen + 0.16);
      chassis.add(rib, nozzle);
    }
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, 0.045, 0.16), darkTrimMat);
    cowl.position.set(0, beltY + 0.022, frontFaceZ - hoodLen + 0.04);
    const wiperL = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.014, 0.022), mirrorBezelMat);
    wiperL.position.set(0.22, beltY + 0.058, frontFaceZ - hoodLen + 0.01);
    wiperL.rotation.z = -0.045;
    wiperL.rotation.y = 0.08;
    const wiperR = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.014, 0.02), mirrorBezelMat);
    wiperR.position.set(-0.28, beltY + 0.056, frontFaceZ - hoodLen + 0.02);
    wiperR.rotation.z = -0.035;
    wiperR.rotation.y = 0.06;
    chassis.add(cowl, wiperL, wiperR);

    // Задний модуль хэтчбека + чёрный диффузор + хромированный выхлоп
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, lowerH * 0.98, trunkLen), paintMat);
    trunk.position.set(0, sillY + lowerH * 0.49, rearFaceZ + trunkLen / 2);
    trunk.castShadow = true;
    // Для зеркала нужна верхняя поверхность кормы, а не передняя стенка грубого
    // BoxGeometry (она скрыта салоном в обычном виде, но выглядит как висящий ящик
    // при выборочном рендере). Отдельная поверхность — только для слоя отражения.
    const rearReferenceGeometry = new THREE.BufferGeometry();
    const refFrontZ = rearFaceZ + trunkLen * 0.78;
    const refBackZ = rearFaceZ + 0.025;
    const refY = sillY + lowerH * 0.98;
    rearReferenceGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
      -W * 0.42, refY, refFrontZ,
       W * 0.42, refY, refFrontZ,
       W * 0.47, refY - 0.025, refBackZ,
      -W * 0.42, refY, refFrontZ,
       W * 0.47, refY - 0.025, refBackZ,
      -W * 0.47, refY - 0.025, refBackZ,
    ], 3));
    rearReferenceGeometry.computeVertexNormals();
    const rearReference = new THREE.Mesh(rearReferenceGeometry, paintMat);
    rearReference.name = "rear-mirror-deck-reference";
    rearReference.userData.rearMirrorOnly = true;
    rearReference.receiveShadow = true;
    chassis.add(rearReference);
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(W - 0.06, 0.12, 0.18), darkTrimMat);
    diffuser.position.set(0, sillY + 0.05, rearFaceZ + 0.08);
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.14, 10), chromeMat);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(-W * 0.31, sillY + 0.05, rearFaceZ - 0.01);
    chassis.add(trunk, diffuser, exhaust);

    // Крыша, наклонные стойки A/C, задний спойлер с доп. стоп-сигналом CHMSL и «акулий плавник»
    const roofLen = L * 0.46;
    const roofW = W * 0.82;
    const roofY = H - 0.03;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.055, roofLen), paintMat);
    roof.position.set(0, roofY, centerShiftZ - 0.16);
    roof.castShadow = true;
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(roofW - 0.04, 0.045, 0.2), paintMat);
    spoiler.position.set(0, roofY + 0.01, centerShiftZ - 0.16 - roofLen * 0.5 - 0.06);
    const chmsl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.024, 0.025), brakeMat);
    chmsl.position.set(0, roofY + 0.012, centerShiftZ - 0.16 - roofLen * 0.5 - 0.162);
    const sharkFin = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.075, 0.15), paintMat);
    sharkFin.position.set(0, roofY + 0.05, centerShiftZ - 0.16 - roofLen * 0.34);
    chassis.add(roof, spoiler, chmsl, sharkFin);

    const pillarOffsets: Array<[number, number, number]> = [
      [roofW / 2 - 0.03, centerShiftZ + roofLen * 0.44, -0.46],
      [-roofW / 2 + 0.03, centerShiftZ + roofLen * 0.44, -0.46],
      [roofW / 2 - 0.03, centerShiftZ - roofLen * 0.55, 0.38],
      [-roofW / 2 + 0.03, centerShiftZ - roofLen * 0.55, 0.38],
    ];
    for (const [px, pz, tilt] of pillarOffsets) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.055, H - beltY + 0.08, 0.07), paintMat);
      p.position.set(px, (beltY + roofY) / 2, pz);
      p.rotation.x = tilt;
      chassis.add(p);
    }

    // Лобовое и заднее стёкла
    const windshield = new THREE.Mesh(new THREE.PlaneGeometry(roofW - 0.06, 0.68), glassMat);
    windshield.position.set(0, (beltY + roofY) / 2, centerShiftZ + roofLen * 0.48);
    windshield.rotation.x = -0.58;
    const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(roofW - 0.08, 0.62), glassMat);
    rearGlass.position.set(0, (beltY + roofY) / 2, centerShiftZ - roofLen * 0.62);
    rearGlass.rotation.x = Math.PI + 0.52;
    chassis.add(windshield, rearGlass);

    // Детализированный «живой» салон Kia Ceed JD: торпедо, Supervision, 7" ШГУ + R-камера, климат, АКПП, ручник, педали
    const dashZ = centerShiftZ + cabinLen * 0.35;
    const dash = new THREE.Mesh(new THREE.BoxGeometry(W - wall * 2.1, 0.25, 0.4), darkTrimMat);
    dash.position.set(0, beltY - 0.055, dashZ + 0.02);
    // Мягкий верхний козырёк торпедо с серебристым молдингом Kia Ceed JD
    const dashTopPad = new THREE.Mesh(new THREE.BoxGeometry(W - wall * 2.15, 0.045, 0.36), mirrorBezelMat);
    dashTopPad.position.set(0, beltY + 0.062, dashZ + 0.03);
    const dashTrimStrip = new THREE.Mesh(new THREE.BoxGeometry(W - wall * 2.3, 0.014, 0.016), satinSilverMat);
    dashTrimStrip.position.set(0, beltY - 0.028, dashZ - 0.175);

    // Козырёк и наклонённый к глазам водителя щиток приборов Supervision (512×192)
    const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.155, 0.25), mirrorBezelMat);
    binnacle.position.set(W * 0.23, beltY + 0.112, dashZ - 0.015);
    const binnacleTrim = new THREE.Mesh(new THREE.BoxGeometry(0.39, 0.012, 0.02), satinSilverMat);
    binnacleTrim.position.set(W * 0.23, beltY + 0.178, dashZ - 0.138);
    const cluster = new THREE.Mesh(
      new THREE.PlaneGeometry(0.356, 0.134),
      new THREE.MeshBasicMaterial({ map: clusterTex, toneMapped: false })
    );
    cluster.position.set(W * 0.23, beltY + 0.098, dashZ - 0.156);
    cluster.rotation.order = "YXZ";
    cluster.rotation.y = Math.PI;
    cluster.rotation.x = 0.16;

    // Кнопка запуска двигателя ENGINE START/STOP в хромированном кольце (справа от рулевой колонки)
    const startRing = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.025, 0.014, 14), chromeMat);
    startRing.rotation.x = Math.PI / 2;
    startRing.position.set(W * 0.118, beltY + 0.012, dashZ - 0.178);
    startBtnMat = new THREE.MeshBasicMaterial({ color: 0xd97706, toneMapped: false });
    const startCore = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.016, 14), startBtnMat);
    startCore.rotation.x = Math.PI / 2;
    startCore.position.set(W * 0.118, beltY + 0.012, dashZ - 0.18);

    // Поворотный переключатель света фар слева от рулевой колонки (L) — как на реальном Kia Ceed JD
    headlightSwitchMat = new THREE.MeshBasicMaterial({ color: 0x334155, toneMapped: false });
    headlightSwitchPivot = new THREE.Group();
    headlightSwitchPivot.position.set(W * 0.23 - 0.145, beltY + 0.018, dashZ - 0.172);
    const hlRing = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.014, 14), chromeMat);
    hlRing.rotation.x = Math.PI / 2;
    const hlKnob = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.02, 12), headlightSwitchMat);
    hlKnob.rotation.x = Math.PI / 2;
    hlKnob.position.z = -0.008;
    const hlMark = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.014, 0.004), new THREE.MeshBasicMaterial({ color: 0xf8fafc }));
    hlMark.position.set(0, 0.01, -0.019);
    headlightSwitchPivot.add(hlRing, hlKnob, hlMark);

    // Боковые дефлекторы обдува и перчаточный ящик (бардачок) пассажира
    for (const side of [1, -1] as const) {
      const ventFrame = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.068, 0.018), satinSilverMat);
      ventFrame.position.set(side * (W * 0.375), beltY + 0.018, dashZ - 0.176);
      const ventCore = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.052, 0.02), mirrorBezelMat);
      ventCore.position.set(side * (W * 0.375), beltY + 0.018, dashZ - 0.178);
      chassis.add(ventFrame, ventCore);
    }
    const gloveHandle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.016), satinSilverMat);
    gloveHandle.position.set(-W * 0.24, beltY - 0.075, dashZ - 0.18);

    // Центральная консоль Kia Ceed JD, слегка развёрнутая к водителю (+X)
    const centerStack = new THREE.Group();
    centerStack.position.set(0, beltY + 0.038, dashZ - 0.176);
    centerStack.rotation.y = 0.09;
    const huBezel = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.176, 0.036), mirrorBezelMat);
    huBezel.position.set(0, 0.02, 0.01);
    const huSilver = new THREE.Mesh(new THREE.BoxGeometry(0.272, 0.158, 0.014), satinSilverMat);
    huSilver.position.set(0, 0.02, -0.006);

    headUnitScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.246, 0.142),
      cockpitTextures
        ? new THREE.MeshBasicMaterial({ map: cockpitTextures.headUnitTex, toneMapped: false })
        : new THREE.MeshBasicMaterial({ color: 0x102030 })
    );
    headUnitScreen.position.set(0, 0.02, -0.016);
    headUnitScreen.rotation.y = Math.PI;
    centerStack.add(huBezel, huSilver, headUnitScreen);

    if (cockpitTextures) {
      // Экран камеры заднего вида R (отражённые UV под cockpitRearRT + прозрачный слой парковочных линий Аккермана)
      rearCamScreen = new THREE.Mesh(makeMirroredPlaneGeometry(0.246, 0.142), mirrorDefaultGlassMat);
      rearCamScreen.position.set(0, 0.02, -0.016);
      rearCamScreen.rotation.y = Math.PI;
      rearCamScreen.visible = false;
      rearCamOverlay = new THREE.Mesh(
        new THREE.PlaneGeometry(0.246, 0.142),
        new THREE.MeshBasicMaterial({
          map: cockpitTextures.rearOverlayTex,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        })
      );
      rearCamOverlay.position.set(0, 0.02, -0.019);
      rearCamOverlay.rotation.y = Math.PI;
      rearCamOverlay.visible = false;
      centerStack.add(rearCamScreen, rearCamOverlay);
    }

    // Шайбы громкости/настройки VOL·TUNE и боковые центральные дефлекторы
    for (const side of [1, -1] as const) {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.018, 12), chromeMat);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(side * 0.142, -0.036, -0.012);
      knob.userData.cockpitControl = (side === 1 ? "vol" : "tune") satisfies CockpitControlId;
      if (side === 1) headUnitKnobL = knob;
      else headUnitKnobR = knob;
      const cVent = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.135, 0.022), mirrorBezelMat);
      cVent.position.set(side * 0.185, 0.018, 0.004);
      centerStack.add(knob, cVent);
    }

    // Красная кнопка аварийной сигнализации ▲ (мигает при включённой аварийке Z)
    hazardBtnMat = new THREE.MeshBasicMaterial({ color: 0x991b1b, toneMapped: false });
    const hazardBtn = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.026, 0.016), hazardBtnMat);
    hazardBtn.position.set(0, -0.082, -0.01);

    // Блок двухзонного климат-контроля с двумя хромированными шайбами и фирменной тёплой подсветкой Kia
    const climatePanel = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.072, 0.026), mirrorBezelMat);
    climatePanel.position.set(0, -0.138, 0.002);
    const kiaBacklightMat = new THREE.MeshBasicMaterial({ color: 0xea580c });
    const climateLcd = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.026), kiaBacklightMat);
    climateLcd.position.set(0, -0.134, -0.0145);
    climateLcd.rotation.y = Math.PI;
    for (const side of [1, -1] as const) {
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.02, 14), chromeMat);
      dial.rotation.x = Math.PI / 2;
      dial.position.set(side * 0.095, -0.138, -0.012);
      const dialCenter = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.022, 12), mirrorBezelMat);
      dialCenter.rotation.x = Math.PI / 2;
      dialCenter.position.set(side * 0.095, -0.138, -0.013);
      centerStack.add(dial, dialCenter);
    }
    centerStack.add(hazardBtn, climatePanel, climateLcd);

    // Центральный тоннель, интерактивный селектор 6АКПП Shiftronic (P–R–N–D + M+/−), ручник и подлокотник
    const consoleTunnel = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.252, 0.96), darkTrimMat);
    consoleTunnel.position.set(0, sillY + 0.175, centerShiftZ + 0.18);
    const consoleArmrest = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.09, 0.34), mirrorBezelMat);
    consoleArmrest.position.set(0, sillY + 0.33, centerShiftZ - 0.12);

    const gateZ = centerShiftZ + SHIFTER_LAYOUT.gateOffsetZ;
    const gateY = SHIFTER_LAYOUT.gateY;
    gearGateRimMat = new THREE.MeshStandardMaterial({
      color: 0xb8c4d0,
      metalness: 0.72,
      roughness: 0.28,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    const gateBezel = new THREE.Mesh(new THREE.BoxGeometry(0.148, 0.014, 0.21), gearGateRimMat);
    gateBezel.position.set(SHIFTER_LAYOUT.gateX, gateY, gateZ);
    const gatePlate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.128, 0.192),
      new THREE.MeshBasicMaterial({ map: makeShifterGateTexture(), toneMapped: false })
    );
    gatePlate.rotation.x = -Math.PI / 2;
    gatePlate.rotation.z = Math.PI;
    gatePlate.position.set(SHIFTER_LAYOUT.gateX, gateY + 0.008, gateZ);

    gearGateDotMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, toneMapped: false });
    gearGateDot = new THREE.Mesh(new THREE.CircleGeometry(0.0068, 12), gearGateDotMat);
    gearGateDot.rotation.x = -Math.PI / 2;
    gearGateDot.position.set(SHIFTER_LAYOUT.mainDotX, gateY + 0.0095, gateZ + SHIFTER_LAYOUT.offP);

    gearLeverPivot = new THREE.Group();
    gearLeverPivot.position.set(SHIFTER_LAYOUT.mainRailX, gateY + 0.006, gateZ + SHIFTER_LAYOUT.offP);
    const shiftBoot = new THREE.Mesh(new THREE.ConeGeometry(0.033, 0.05, 10), mirrorBezelMat);
    shiftBoot.position.y = 0.023;
    const shiftCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.016, 10), chromeMat);
    shiftCollar.position.y = 0.098;
    const shiftShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0082, 0.106, 10), chromeMat);
    shiftShaft.position.y = 0.068;
    const shiftKnob = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.042, 0.072), mirrorBezelMat);
    shiftKnob.position.set(0, 0.128, 0.006);
    gearKnobCapMat = new THREE.MeshStandardMaterial({
      color: 0xc2ceda,
      metalness: 0.74,
      roughness: 0.25,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    const shiftKnobCap = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.011, 0.054), gearKnobCapMat);
    shiftKnobCap.position.set(0, 0.15, 0.006);
    // Передняя хромированная клавиша снятия блокировки P/R (как на реальном селекторе Kia Ceed JD)
    const shiftTrigger = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.018, 0.01), chromeMat);
    shiftTrigger.position.set(0, 0.124, 0.043);
    gearLeverPivot.add(shiftBoot, shiftShaft, shiftCollar, shiftKnob, shiftKnobCap, shiftTrigger);

    // Невидимые точные зоны наведения/клика/перетаскивания 3D-рычага АКПП и пазов кулисы
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    });
    const knobHit = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.165, 0.098), hitMat);
    knobHit.position.set(0, 0.098, 0.006);
    knobHit.userData.shifterHit = "lever" satisfies ShifterHitId;
    gearLeverPivot.add(knobHit);

    const slotGroup = new THREE.Group();
    const slotDefs: Array<[ShifterHitId, number, number, number, number]> = [
      ["P", 0.008, SHIFTER_LAYOUT.offP, 0.088, 0.034],
      ["R", 0.008, SHIFTER_LAYOUT.offR, 0.088, 0.034],
      ["N", 0.008, SHIFTER_LAYOUT.offN, 0.088, 0.034],
      ["D", 0.0, SHIFTER_LAYOUT.offD, 0.072, 0.036],
      ["M", SHIFTER_LAYOUT.manualRailX, SHIFTER_LAYOUT.offD, 0.042, 0.03],
      ["M+", SHIFTER_LAYOUT.manualRailX, SHIFTER_LAYOUT.offMPlus, 0.044, 0.04],
      ["M-", SHIFTER_LAYOUT.manualRailX, SHIFTER_LAYOUT.offMMinus, 0.044, 0.034],
    ];
    shifterPickTargets = [knobHit];
    for (const [id, sx, sz, sw, sd] of slotDefs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.02, sd), hitMat);
      m.position.set(sx, gateY + 0.014, gateZ + sz);
      m.userData.shifterHit = id;
      slotGroup.add(m);
      shifterPickTargets.push(m);
    }
    chassis.add(slotGroup);

    // Рычаг стояночного тормоза (поднят на холодном старте, опускается при снятии Space)
    handbrakePivot = new THREE.Group();
    handbrakePivot.position.set(-0.052, gateY + 0.012, centerShiftZ + 0.1);
    handbrakePivot.rotation.x = -0.44;
    const hbArm = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.03, 0.2), mirrorBezelMat);
    hbArm.position.set(0, 0.015, 0.095);
    const hbBtn = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.024, 8), chromeMat);
    hbBtn.rotation.x = Math.PI / 2;
    hbBtn.position.set(0, 0.016, 0.2);
    handbrakePivot.add(hbArm, hbBtn);

    // Педальный узел АКПП в нише водителя (широкая педаль тормоза слева + напольная педаль газа справа)
    brakePedalPivot = new THREE.Group();
    brakePedalPivot.position.set(W * 0.245, sillY + 0.26, dashZ + 0.04);
    const bArm = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.15, 0.018), darkTrimMat);
    bArm.position.set(0, -0.07, -0.03);
    const bPad = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.052, 0.016), satinSilverMat);
    bPad.position.set(0, -0.135, -0.048);
    brakePedalPivot.add(bArm, bPad);

    gasPedalPivot = new THREE.Group();
    gasPedalPivot.position.set(W * 0.165, sillY + 0.25, dashZ + 0.06);
    const gArm = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.16, 0.014), darkTrimMat);
    gArm.position.set(0, -0.075, -0.02);
    const gPad = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.105, 0.014), satinSilverMat);
    gPad.position.set(0, -0.13, -0.032);
    gasPedalPivot.add(gArm, gPad);

    // Потолочная консоль плафона освещения и очечника
    const domeConsole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.022, 0.18), darkTrimMat);
    domeConsole.position.set(0, roofY - 0.032, centerShiftZ + 0.56);

    // Невидимые зоны клика по органам салона: 7" ШГУ, шайбы VOL/TUNE, аварийка, ENGINE START/STOP,
    // поворотный переключатель света фар, левый подрулевой (поворотники) и рычаг стояночного тормоза.
    const pickGroup = new THREE.Group();
    const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    const addPick = (id: CockpitControlId, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), pickMat);
      m.position.set(x, y, z);
      m.userData.cockpitControl = id;
      pickGroup.add(m);
      return m;
    };
    cockpitPickTargets = [
      addPick("headunit", 0.0, beltY + 0.058, dashZ - 0.2, 0.238, 0.152, 0.03),
      addPick("vol", 0.142, beltY + 0.002, dashZ - 0.201, 0.05, 0.05, 0.032),
      addPick("tune", -0.142, beltY + 0.002, dashZ - 0.201, 0.05, 0.05, 0.032),
      addPick("hazard", 0.0, beltY - 0.044, dashZ - 0.201, 0.056, 0.044, 0.032),
      addPick("start", W * 0.118, beltY + 0.012, dashZ - 0.196, 0.056, 0.056, 0.032),
      addPick("headlight", W * 0.23 - 0.145, beltY + 0.018, dashZ - 0.19, 0.062, 0.062, 0.032),
      addPick("stalk-left", W * 0.23 + 0.112, 0.9, centerShiftZ + 0.55, 0.15, 0.07, 0.07),
      addPick("handbrake", -0.052, gateY + 0.055, centerShiftZ + 0.19, 0.07, 0.085, 0.24),
      // Сигнал: накладка ступицы, зона заметно уже обода (0,062 м против радиуса 0,172 м) и смещена от консоли.
      // Широкая зона перехватывала бы клики по кулисе АКПП и шайбам ШГУ, которые лежат ниже и правее (смоук K7c/K7d).
      // Раскладка и зазоры — чистый модуль `sim/cockpitLayout.ts`, проверяются T41.
      addPick(HORN_PICK.id as CockpitControlId, HORN_PICK.cx, HORN_PICK.cy, HORN_PICK.cz, HORN_PICK.sx, HORN_PICK.sy, HORN_PICK.sz),
    ];
    chassis.add(pickGroup);

    chassis.add(
      dash,
      dashTopPad,
      dashTrimStrip,
      binnacle,
      binnacleTrim,
      cluster,
      startRing,
      startCore,
      headlightSwitchPivot,
      gloveHandle,
      centerStack,
      consoleTunnel,
      consoleArmrest,
      gateBezel,
      gatePlate,
      gearGateDot,
      gearLeverPivot,
      handbrakePivot,
      brakePedalPivot,
      gasPedalPivot,
      domeConsole
    );

    const seatMat = new THREE.MeshStandardMaterial({ color: 0x28313c, roughness: 0.86 });
    const doorCardMat = new THREE.MeshStandardMaterial({ color: 0x202730, roughness: 0.8 });
    for (const side of [1, -1] as const) {
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.12, 0.48), seatMat);
      cushion.position.set(side * W * 0.24, 0.44, centerShiftZ + 0.04);
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.11), seatMat);
      seatBack.position.set(side * W * 0.24, 0.69, centerShiftZ - 0.17);
      seatBack.rotation.x = -0.14;
      const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.09), seatMat);
      headrest.position.set(side * W * 0.24, 1.04, centerShiftZ - 0.23);

      // Внутренняя обшивка передних дверей с подлокотником, блоком стеклоподъёмников, динамиком и ручкой
      const doorCard = new THREE.Mesh(new THREE.BoxGeometry(0.028, lowerH - 0.08, cabinLen * 0.48), doorCardMat);
      doorCard.position.set(side * (W / 2 - wall - 0.012), sillY + 0.06 + (lowerH - 0.08) / 2, centerShiftZ + 0.36);
      const doorTrimLine = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.54), satinSilverMat);
      doorTrimLine.position.set(side * (W / 2 - wall - 0.027), beltY - 0.055, centerShiftZ + 0.4);
      const armrest = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.045, 0.44), darkTrimMat);
      armrest.position.set(side * (W / 2 - wall - 0.032), beltY - 0.16, centerShiftZ + 0.32);
      const switchPod = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.012, 0.13), mirrorBezelMat);
      switchPod.position.set(side * (W / 2 - wall - 0.035), beltY - 0.134, centerShiftZ + 0.44);
      const innerPull = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.024, 0.09), chromeMat);
      innerPull.position.set(side * (W / 2 - wall - 0.028), beltY - 0.09, centerShiftZ + 0.5);
      // Катушка ремня безопасности на средней стойке B
      const beltAnchor = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.055), mirrorBezelMat);
      beltAnchor.position.set(side * (W * 0.41), 1.12, centerShiftZ - 0.14);
      // Сложенный солнцезащитный козырёк под кромкой потолка (не перекрывает обзор)
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.018, 0.13), seatMat);
      visor.position.set(side * 0.36, roofY - 0.034, centerShiftZ + roofLen * 0.4 - 0.03);
      visor.rotation.x = 0.08;
      chassis.add(cushion, seatBack, headrest, doorCard, doorTrimLine, armrest, switchPod, innerPull, beltAnchor, visor);
    }

    // Диагональная лента пристёгнутого ремня безопасности водителя (появляется при нажатии B)
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.048, 0.62, 0.01),
      new THREE.MeshStandardMaterial({ color: 0x11151b, roughness: 0.7 })
    );
    strap.position.set(W * 0.25, 0.84, centerShiftZ - 0.08);
    strap.rotation.z = -0.56;
    strap.rotation.x = -0.18;
    strap.visible = false;
    seatbeltStrap = strap;
    chassis.add(strap);

    // Физическое салонное зеркало заднего вида под верхним краем лобового стекла (с живым отражением в «Салоне»)
    const rearMirrorAssembly = new THREE.Group();
    const sensorPod = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.052, 0.11), mirrorBezelMat);
    sensorPod.position.set(0, roofY - 0.032, centerShiftZ + 0.745);
    sensorPod.rotation.x = -0.34;
    const rearStem = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0105, 0.082, 8), mirrorBezelMat);
    rearStem.position.set(0, 1.36, centerShiftZ + 0.692);
    rearStem.rotation.x = -0.62;
    const ballJoint = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), mirrorBezelMat);
    ballJoint.position.set(0, 1.334, centerShiftZ + 0.66);

    const rearHead = new THREE.Group();
    rearHead.position.set(0, 1.326, centerShiftZ + 0.644);
    // Разворот зеркального полотна (-Z) к глазам водителя (+X, чуть вниз)
    rearHead.rotation.order = "YXZ";
    rearHead.rotation.y = -0.27;
    rearHead.rotation.x = -0.11;
    const rgw = 0.272;
    const rgh = 0.078;
    const rf = 0.0065;
    const rearBack = new THREE.Mesh(new THREE.BoxGeometry(rgw + rf * 2, rgh + rf * 2, 0.018), mirrorBezelMat);
    rearBack.position.z = 0.012;
    const rearCap = new THREE.Mesh(new THREE.BoxGeometry(rgw * 0.78, rgh * 0.72, 0.014), darkTrimMat);
    rearCap.position.z = 0.025;
    // Утопленная рамка по периметру салонного зеркала
    const rTop = new THREE.Mesh(new THREE.BoxGeometry(rgw + rf * 2, rf, 0.01), mirrorBezelMat);
    rTop.position.set(0, (rgh + rf) / 2, -0.001);
    const rBot = new THREE.Mesh(new THREE.BoxGeometry(rgw + rf * 2, rf, 0.01), mirrorBezelMat);
    rBot.position.set(0, -(rgh + rf) / 2, -0.001);
    const rSideL = new THREE.Mesh(new THREE.BoxGeometry(rf, rgh, 0.01), mirrorBezelMat);
    rSideL.position.set((rgw + rf) / 2, 0, -0.001);
    const rSideR = new THREE.Mesh(new THREE.BoxGeometry(rf, rgh, 0.01), mirrorBezelMat);
    rSideR.position.set(-(rgw + rf) / 2, 0, -0.001);
    // Флажок антибликового переключения «день/ночь» снизу по центру
    const dayNightTab = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.012, 0.016), darkTrimMat);
    dayNightTab.position.set(0, -rgh / 2 - rf - 0.005, 0.003);
    dayNightTab.rotation.x = 0.25;

    rearMirrorGlass = new THREE.Mesh(makeMirroredPlaneGeometry(rgw, rgh), mirrorDefaultGlassMat);
    rearMirrorGlass.rotation.y = Math.PI;
    rearMirrorGlass.position.z = -0.001;
    rearHead.add(rearBack, rearCap, rTop, rBot, rSideL, rSideR, dayNightTab, rearMirrorGlass);
    rearMirrorAssembly.add(sensorPod, rearStem, ballJoint, rearHead);
    setMirrorLayer(rearMirrorAssembly);
    chassis.add(rearMirrorAssembly);

    // Водитель на левом кресле (+X; виден снаружи, скрывается в виде из салона)
    driverGroup = new THREE.Group();
    const driverX = W * 0.23;
    const driverZ = centerShiftZ - 0.02;
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.46, 0.21),
      new THREE.MeshStandardMaterial({ color: 0x2454a6, roughness: 0.72 })
    );
    torso.position.set(driverX, 0.82, driverZ);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.112, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xe8be9e, roughness: 0.6 })
    );
    head.position.set(driverX, 1.16, driverZ - 0.01);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
      new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.82 })
    );
    hair.position.copy(head.position);
    driverGroup.add(torso, head, hair);
    chassis.add(driverGroup);
  } else {
    // Детализированный припаркованный автомобиль (седан / хэтчбек / кроссовер Sorento)
    const lower = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, lowerH - 0.05, L - 0.04), paintMat);
    lower.position.set(0, sillY + 0.05 + (lowerH - 0.05) / 2, 0);
    lower.castShadow = true;
    lower.receiveShadow = true;
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W, 0.075, L), darkTrimMat);
    skirt.position.set(0, sillY + 0.03, 0);

    const cabLen = isSuv ? L * 0.6 : L * 0.52;
    const cabZ = isSuv ? -L * 0.08 : -L * 0.05;
    const cabH = H - beltY;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.83, cabH - 0.03, cabLen), glassMat);
    cabin.position.set(0, beltY + cabH * 0.5 - 0.02, cabZ);
    const roofCap = new THREE.Mesh(new THREE.BoxGeometry(W * 0.81, 0.065, cabLen * 0.9), paintMat);
    roofCap.position.set(0, H - 0.025, cabZ);
    roofCap.castShadow = true;
    chassis.add(lower, skirt, cabin, roofCap);

    // Серебристые рейлинги на крыше кроссовера Sorento и боковые зеркала
    for (const side of [1, -1] as const) {
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.09), paintMat);
      mir.position.set(side * (W * 0.5 + 0.04), beltY + 0.05, L * 0.14);
      chassis.add(mir);
      if (isSuv) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, cabLen * 0.8), chromeMat);
        rail.position.set(side * (W * 0.36), H + 0.03, cabZ);
        chassis.add(rail);
      }
    }
  }

  // Фирменная решётка радиатора Kia «Tiger Nose» с хромом, нижний воздухозаборник и госномера ГОСТ Р 50577
  const frontZ = frontFaceZ + 0.008;
  const rearZ = rearFaceZ - 0.008;
  const grilleY = sillY + lowerH * 0.66;

  const grilleChrome = new THREE.Mesh(new THREE.BoxGeometry(W * 0.44, 0.14, 0.025), chromeMat);
  grilleChrome.position.set(0, grilleY, frontZ - 0.004);
  const grilleMesh = new THREE.Mesh(new THREE.BoxGeometry(W * 0.41, 0.11, 0.03), darkTrimMat);
  grilleMesh.position.set(0, grilleY, frontZ);
  const lowerIntake = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, 0.11, 0.025), darkTrimMat);
  lowerIntake.position.set(0, sillY + 0.14, frontZ - 0.004);

  const fPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112), plateMat);
  fPlate.position.set(0, sillY + 0.27, frontZ + 0.012);
  const rPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112), plateMat);
  rPlate.position.set(0, sillY + lowerH * 0.52, rearZ - 0.012);
  rPlate.rotation.y = Math.PI;
  chassis.add(grilleChrome, grilleMesh, lowerIntake, fPlate, rPlate);

  // Трёхспицевое мультирулевое колесо Kia Ceed JD (+X — левая сторона), кожух колонки и подрулевые рычажки
  const steerWheelMesh = new THREE.Group();
  steerWheelMesh.position.set(W * 0.23, 0.905, centerShiftZ + 0.485);
  steerWheelMesh.rotation.x = 0.34;
  if (isPlayer) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.172, 0.0195, 12, 28),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.42, metalness: 0.08 })
    );
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.064, 0.04, 16), mirrorBezelMat);
    hub.rotation.x = Math.PI / 2;
    const badgeRing = new THREE.Mesh(new THREE.RingGeometry(0.019, 0.024, 16), chromeMat);
    badgeRing.rotation.y = Math.PI;
    badgeRing.position.z = -0.021;
    badgeRing.scale.set(1.35, 0.78, 1);
    const barH = new THREE.Mesh(new THREE.BoxGeometry(0.305, 0.028, 0.022), darkTrimMat);
    barH.position.y = -0.012;
    // Мультикнопки на левой и правой спицах и серебристая V-вставка нижней спицы Kia Ceed JD
    for (const sgn of [1, -1] as const) {
      const btnPad = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.038, 0.026), satinSilverMat);
      btnPad.position.set(sgn * 0.108, -0.01, -0.004);
      steerWheelMesh.add(btnPad);
    }
    // Кнопка сигнала в центре ступицы: чёрная накладка с эмблемой-гудком, отличается от накладок спиц
    const hornPad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.046, 0.05, 0.014, 18),
      new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.6, metalness: 0.18 })
    );
    hornPad.rotation.x = Math.PI / 2;
    hornPad.position.z = -0.026;
    const hornGlyph = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.017, 14), chromeMat);
    hornGlyph.position.z = -0.036;
    hornGlyph.scale.set(1.3, 0.85, 1);
    const barV = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.135, 0.022), satinSilverMat);
    barV.position.y = -0.092;
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.042, 0.042),
      new THREE.MeshBasicMaterial({ color: 0xf5b942 })
    );
    marker.position.set(0, 0.172, 0);
    steerWheelMesh.add(rim, hub, badgeRing, barH, barV, marker, hornPad, hornGlyph);

    // Кожух рулевой колонки и подрулевые переключатели (левый — поворотники Q/E, правый — стеклоочистители)
    const colShroud = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.095, 0.16), darkTrimMat);
    colShroud.position.set(W * 0.23, 0.875, centerShiftZ + 0.585);
    colShroud.rotation.x = 0.24;

    leftStalkPivot = new THREE.Group();
    leftStalkPivot.position.set(W * 0.23 + 0.052, 0.892, centerShiftZ + 0.55);
    const lStalk = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0105, 0.115, 8), mirrorBezelMat);
    lStalk.rotation.z = -Math.PI * 0.44;
    lStalk.position.set(0.052, 0.012, 0);
    leftStalkPivot.add(lStalk);

    const rStalk = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0105, 0.11, 8), mirrorBezelMat);
    rStalk.rotation.z = Math.PI * 0.44;
    rStalk.position.set(W * 0.23 - 0.102, 0.904, centerShiftZ + 0.55);

    chassis.add(steerWheelMesh, colShroud, leftStalkPivot, rStalk);

    // Невидимые зоны клика по органам салона создаются ниже, рядом с геометрией торпедо и тоннеля.
  }

  // Блок-фары, ПТФ, двухсекционные задние фонари, катафоты, зеркала и поворотники (+X левый, -X правый)
  for (const side of [1, -1] as const) {
    const hlHousing = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.13, 0.03), darkTrimMat);
    hlHousing.position.set(side * (W * 0.34), grilleY + 0.02, frontZ - 0.003);
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.032), headlightMat);
    hl.position.set(side * (W * 0.34), grilleY + 0.02, frontZ + 0.002);
    const fog = new THREE.Mesh(new THREE.CircleGeometry(0.042, 10), headlightMat);
    fog.position.set(side * (W * 0.39), sillY + 0.15, frontZ + 0.01);

    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.13, 0.032), brakeMat);
    tl.position.set(side * (W * 0.34), beltY - 0.1, rearZ);
    const refl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.032, 0.02), reflectorMat);
    refl.position.set(side * (W * 0.36), sillY + 0.12, rearZ);
    chassis.add(hlHousing, hl, fog, tl, refl);

    if (isPlayer) {
      const rev = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.075, 0.034), reverseMat);
      rev.position.set(side * (W * 0.2), beltY - 0.1, rearZ - 0.002);
      chassis.add(rev);

      const bMat = new THREE.MeshBasicMaterial({ color: 0x9a621e, toneMapped: false });
      if (side === 1) blinkLeftMats.push(bMat);
      else blinkRightMats.push(bMat);

      // Выступающие секции поворотников (видны с любого ракурса) + аэродинамическое зеркало на ножке
      const blinkF = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.07), bMat);
      blinkF.position.set(side * (W * 0.45), grilleY + 0.02, frontZ + 0.012);
      const blinkR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.07), bMat);
      blinkR.position.set(side * (W * 0.45), beltY - 0.08, rearZ - 0.012);

      // Физическое боковое зеркало Kia Ceed JD в переднем углу двери (парус, стойка, двухцветный корпус, рамка и полотно)
      const sideMirrorGrp = new THREE.Group();
      const mountZ = centerShiftZ + 0.65;
      const mirrorSail = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.088, 0.13), darkTrimMat);
      mirrorSail.position.set(side * (W / 2 - 0.016), beltY + 0.038, mountZ + 0.1);
      const mirrorStalk = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.036, 0.052), darkTrimMat);
      mirrorStalk.position.set(side * (W / 2 + 0.032), beltY + 0.04, mountZ + 0.076);
      mirrorStalk.rotation.z = -side * 0.24;

      const mirrorHead = new THREE.Group();
      mirrorHead.position.set(side * (W / 2 + 0.12), beltY + 0.118, mountZ);
      // Разворот зеркального полотна (-Z) к глазам водителя: левое мягко внутрь, правое сильнее (левый руль +X)
      mirrorHead.rotation.order = "YXZ";
      mirrorHead.rotation.y = side === 1 ? 0.34 : -0.58;
      mirrorHead.rotation.x = 0.08;

      const sw = 0.208;
      const sh = 0.126;
      const sf = 0.0085;
      // Окрашенная в цвет кузова аэродинамическая крышка + матово-чёрное основание и утопленная обойма
      const shellBody = new THREE.Mesh(new THREE.BoxGeometry(sw + sf * 2 + 0.012, sh + sf * 2 + 0.008, 0.056), paintMat);
      shellBody.position.set(0, 0.004, 0.034);
      const shellNose = new THREE.Mesh(new THREE.BoxGeometry(sw * 0.86, sh * 0.78, 0.028), paintMat);
      shellNose.position.set(side * 0.006, 0.002, 0.072);
      const shellBase = new THREE.Mesh(new THREE.BoxGeometry(sw + sf * 2 + 0.008, 0.02, 0.056), darkTrimMat);
      shellBase.position.set(0, -(sh + sf * 2) / 2 + 0.004, 0.033);
      const innerBack = new THREE.Mesh(new THREE.BoxGeometry(sw + sf * 2, sh + sf * 2, 0.01), mirrorBezelMat);
      innerBack.position.z = 0.008;

      const sTop = new THREE.Mesh(new THREE.BoxGeometry(sw + sf * 2 + 0.008, sf, 0.012), mirrorBezelMat);
      sTop.position.set(0, (sh + sf) / 2, 0.001);
      const sBot = new THREE.Mesh(new THREE.BoxGeometry(sw + sf * 2 + 0.008, sf, 0.011), mirrorBezelMat);
      sBot.position.set(0, -(sh + sf) / 2, 0.0015);
      const sLeft = new THREE.Mesh(new THREE.BoxGeometry(sf, sh, 0.011), mirrorBezelMat);
      sLeft.position.set((sw + sf) / 2, 0, 0.0015);
      const sRight = new THREE.Mesh(new THREE.BoxGeometry(sf, sh, 0.011), mirrorBezelMat);
      sRight.position.set(-(sw + sf) / 2, 0, 0.0015);

      const sGlass = new THREE.Mesh(makeMirroredPlaneGeometry(sw, sh), mirrorDefaultGlassMat);
      sGlass.rotation.y = Math.PI;
      sGlass.position.z = -0.001;
      // Гравированная вертикальная риска асферической зоны на наружном крае зеркала
      const aspheric = new THREE.Mesh(new THREE.PlaneGeometry(0.0018, sh - 0.012), asphericLineMat);
      aspheric.rotation.y = Math.PI;
      aspheric.position.set(side * (sw * 0.3), 0, -0.0022);

      // Светодиодный повторитель поворотника в корпусе зеркала (с выходом на наружный торец)
      const blinkFrontStrip = new THREE.Mesh(new THREE.BoxGeometry(sw * 0.56, 0.018, 0.022), bMat);
      blinkFrontStrip.position.set(side * (sw * 0.2), -0.01, 0.078);
      const blinkEdgeTip = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.022, 0.052), bMat);
      blinkEdgeTip.position.set(side * (sw / 2 + sf + 0.008), -0.008, 0.034);

      mirrorHead.add(
        shellBody,
        shellNose,
        shellBase,
        innerBack,
        sTop,
        sBot,
        sLeft,
        sRight,
        sGlass,
        aspheric,
        blinkFrontStrip,
        blinkEdgeTip
      );
      sideMirrorGrp.add(mirrorSail, mirrorStalk, mirrorHead);
      setMirrorLayer(sideMirrorGrp);
      if (side === 1) leftMirrorGlass = sGlass;
      else rightMirrorGlass = sGlass;
      chassis.add(blinkF, blinkR, sideMirrorGrp);
    }
  }

  // Прожекторы фар и магнитный учебный знак «У» на крыше
  let headSpotL: THREE.SpotLight | undefined;
  let headSpotR: THREE.SpotLight | undefined;
  let learnerSign: THREE.Object3D | undefined;

  if (isPlayer) {
    const makeSpot = (sx: number) => {
      const sp = new THREE.SpotLight(0xfff6dc, 0, 28, 0.52, 0.55, 1.4);
      sp.position.set(sx, grilleY + 0.02, frontZ);
      sp.target.position.set(sx * 0.9, 0.05, frontZ + 13);
      chassis.add(sp, sp.target);
      return sp;
    };
    headSpotL = makeSpot(W * 0.34);
    headSpotR = makeSpot(-W * 0.34);

    // Фирменные светодиодные ДХО (DRL) Kia Ceed JD (загораются при запуске ДВС) и подсветка заднего госномера
    drlMat = new THREE.MeshBasicMaterial({ color: 0x64748b, toneMapped: false });
    for (const side of [1, -1] as const) {
      const drlBrow = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.018, 0.016), drlMat);
      drlBrow.position.set(side * (W * 0.34), grilleY + 0.072, frontZ + 0.014);
      const drlLower = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.022, 0.016), drlMat);
      drlLower.position.set(side * (W * 0.385), sillY + 0.205, frontZ + 0.01);
      chassis.add(drlBrow, drlLower);
    }
    plateLightMat = new THREE.MeshBasicMaterial({ color: 0x334155, toneMapped: false });
    const plateLamp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.012, 0.018), plateLightMat);
    plateLamp.position.set(0, sillY + lowerH * 0.52 + 0.064, rearZ - 0.014);
    chassis.add(plateLamp);

    // Мягкие световые пучки ближнего света фар на асфальте (включаются по L при работающем ДВС)
    headlightBeamGroup = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({
      map: makeHeadlightBeamTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const beamLen = 11.5;
    for (const side of [1, -1] as const) {
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(3.1, beamLen), beamMat);
      beam.rotation.x = -Math.PI / 2;
      beam.rotation.z = Math.PI;
      beam.position.set(side * (W * 0.32), 0.048, frontFaceZ + beamLen * 0.5 + 0.25);
      headlightBeamGroup.add(beam);
    }
    headlightBeamGroup.visible = false;
    root.add(headlightBeamGroup);

    const signGrp = new THREE.Group();
    signGrp.position.set(0, H + 0.13, centerShiftZ - 0.12);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.028, 0.15), darkTrimMat);
    pad.position.y = -0.135;
    const signMat = new THREE.MeshBasicMaterial({ map: learnerTex });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35 });
    const signBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.27, 0.11),
      [sideMat, sideMat, sideMat, sideMat, signMat, signMat]
    );
    signGrp.add(pad, signBox);
    chassis.add(signGrp);
    learnerSign = signGrp;
  }

  // Колёса: передние в поворотных кулаках Аккермана, задние на оси
  const flPivot = new THREE.Group();
  const frPivot = new THREE.Group();
  const trackHalf = W / 2 - ww * 0.44;
  flPivot.position.set(trackHalf, wr, wb / 2);
  frPivot.position.set(-trackHalf, wr, wb / 2);

  const wFL = createDetailedWheelMesh(wr, ww);
  const wFR = createDetailedWheelMesh(wr, ww);
  const wRL = createDetailedWheelMesh(wr, ww);
  const wRR = createDetailedWheelMesh(wr, ww);
  wRL.position.set(trackHalf, wr, -wb / 2);
  wRR.position.set(-trackHalf, wr, -wb / 2);
  flPivot.add(wFL);
  frPivot.add(wFR);
  root.add(flPivot, frPivot, wRL, wRR);

  return {
    root,
    chassis,
    flPivot,
    frPivot,
    wheelMeshes: [wFL, wFR, wRL, wRR],
    steerWheelMesh,
    blinkLeftMats,
    blinkRightMats,
    brakeMat,
    reverseMat,
    headlightMat,
    headSpotL,
    headSpotR,
    learnerSign,
    rearMirrorGlass,
    leftMirrorGlass,
    rightMirrorGlass,
    headUnitScreen,
    rearCamScreen,
    rearCamOverlay,
    gearLeverPivot,
    gearGateDot,
    gearGateDotMat,
    gearKnobCapMat,
    gearGateRimMat,
    shifterPickTargets,
    cockpitPickTargets,
    headUnitKnobL,
    headUnitKnobR,
    headlightSwitchPivot,
    headlightSwitchMat,
    handbrakePivot,
    leftStalkPivot,
    hazardBtnMat,
    startBtnMat,
    brakePedalPivot,
    gasPedalPivot,
    seatbeltStrap,
    drlMat,
    plateLightMat,
    headlightBeamGroup,
    driverGroup,
  };
}

const JACKET_COLORS = [0x2b5b84, 0x8c3b3b, 0x2f6b55, 0x6b5b45, 0x4b5563];
const PANTS_COLORS = [0x1e293b, 0x334155, 0x2c3a4f, 0x3b3734];

/** Строит детализированную фигуру пешехода (куртка, рюкзак, причёска, анимированные руки и ноги с обувью, тень). */
export function buildDetailedPedestrian(
  crosswalkId: string,
  index: number,
  shadowTex: THREE.CanvasTexture
): DetailedPedestrianVisual {
  const group = new THREE.Group();

  const jacketMat = new THREE.MeshStandardMaterial({
    color: JACKET_COLORS[index % JACKET_COLORS.length],
    roughness: 0.72,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: PANTS_COLORS[index % PANTS_COLORS.length],
    roughness: 0.85,
  });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xefc6a4, roughness: 0.62 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x181c22, roughness: 0.7 });
  const hairMat = new THREE.MeshStandardMaterial({
    color: index % 2 === 0 ? 0x3a281c : 0x5c4632,
    roughness: 0.8,
  });

  // Мягкая контактная тень на «зебре»
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.75),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.031;
  group.add(shadow);

  // Торс (куртка), воротник и городской рюкзак за спиной
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.56, 0.22), jacketMat);
  torso.position.y = 1.08;
  torso.castShadow = true;
  const pack = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.36, 0.13),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.78 })
  );
  pack.position.set(0, 1.11, -0.16);
  pack.castShadow = true;

  // Шея, голова и причёска
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.1, 8), skinMat);
  neck.position.y = 1.4;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 12), skinMat);
  head.position.y = 1.54;
  head.castShadow = true;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
  hair.position.set(0, 1.545, -0.01);
  group.add(torso, pack, neck, head, hair);

  // Шарниры ног (ось вращения в тазобедренном суставе y = 0.78) с ботинками
  const makeLeg = (sx: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx, 0.78, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.7, 0.145), pantsMat);
    leg.position.y = -0.36;
    leg.castShadow = true;
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.085, 0.24), shoeMat);
    shoe.position.set(0, -0.735, 0.045);
    pivot.add(leg, shoe);
    return pivot;
  };
  const legL = makeLeg(0.1);
  const legR = makeLeg(-0.1);

  // Шарниры рук (ось вращения в плече y = 1.32) с кистями
  const makeArm = (sx: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx, 1.32, 0);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.5, 0.115), jacketMat);
    sleeve.position.y = -0.24;
    sleeve.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), skinMat);
    hand.position.y = -0.52;
    pivot.add(sleeve, hand);
    return pivot;
  };
  const armL = makeArm(0.245);
  const armR = makeArm(-0.245);

  group.add(legL, legR, armL, armR);
  return { crosswalkId, group, legL, legR, armL, armR };
}
