import * as THREE from "three";
import type {
  CameraMode,
  ObstacleBox,
  ParkedModelKey,
  ParkingBay,
  QualityPreset,
  SimState,
  TrafficSignalDef,
  WorldData,
} from "../sim/types";
import {
  CAR,
  clamp,
  getPedestrianPose,
  getTrafficLightPhase,
  getTurnSignalFlash,
  predictTrajectoryArc,
  VEHICLE_DIMS,
} from "../sim/vehicle";

// Слои относятся только к геометрии машины игрока. Мир и припаркованные авто — слой 0.
const PLAYER_EXTERIOR_LAYER = 1;
const OWN_MIRROR_HARDWARE_LAYER = 2;

type CarRig = {
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
  learnerSign?: THREE.Mesh;
};

type SignalVisual = {
  def: TrafficSignalDef;
  redMat: THREE.MeshBasicMaterial;
  yellowMat: THREE.MeshBasicMaterial;
  greenMat: THREE.MeshBasicMaterial;
};

type PedestrianVisual = {
  crosswalkId: string;
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
};

type BayVisual = {
  bay: ParkingBay;
  lineMat: THREE.MeshBasicMaterial;
};

export type RenderOptions = {
  cameraMode: CameraMode;
  quality: QualityPreset;
  showTrajectory: boolean;
  showMirrors: boolean;
  showRearMirror: boolean;
  showLearnerSign: boolean;
  drawRadius: number;
};

export type PerfMetrics = {
  fps: number;
  p95FrameMs: number;
  visibleBuildings: number;
  totalBuildings: number;
};

function makeSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#35669c");
  grad.addColorStop(0.48, "#7aa8d1");
  grad.addColorStop(0.82, "#bfd7ea");
  grad.addColorStop(1, "#dde8f0");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeAsphaltTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2f363f";
  g.fillRect(0, 0, 128, 128);
  // Детерминированное зерно асфальта
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 1400; i++) {
    const shade = 38 + Math.floor(rand() * 26);
    g.fillStyle = `rgb(${shade},${shade + 3},${shade + 7})`;
    g.fillRect(Math.floor(rand() * 128), Math.floor(rand() * 128), 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeContactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 14, 64, 64, 62);
  grad.addColorStop(0, "rgba(0,0,0,0.58)");
  grad.addColorStop(0.65, "rgba(0,0,0,0.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeBuildingWindowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#cfd8e0";
  g.fillRect(0, 0, 128, 128);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const lit = (row * 7 + col * 3) % 5 === 0;
      g.fillStyle = lit ? "#86a8c5" : "#425466";
      g.fillRect(col * 32 + 7, row * 32 + 6, 18, 19);
      g.strokeStyle = "#95a3af";
      g.lineWidth = 1.5;
      g.strokeRect(col * 32 + 7, row * 32 + 6, 18, 19);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeLearnerSignTexture(): THREE.CanvasTexture {
  // Табличка «У» (порт из v2; прим.: форма и пропорции — учебная визуализация)
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#dc2626";
  g.lineWidth = 18;
  g.strokeRect(9, 9, 110, 110);
  g.fillStyle = "#111827";
  g.font = "800 76px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("У", 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSpeedSignTexture(limit: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fillStyle = "#ffffff";
  g.fill();
  g.lineWidth = 14;
  g.strokeStyle = "#dc2626";
  g.stroke();
  g.fillStyle = "#0f172a";
  g.font = "800 54px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(limit), 64, 67);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBayNumberTexture(num: number, occupied: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = occupied ? "rgba(148,163,184,0.45)" : "rgba(245,185,66,0.92)";
  g.font = "800 68px monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(num), 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createWheelMesh(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 18);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.85 });
  g.add(new THREE.Mesh(tireGeo, tireMat));

  const rimGeo = new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, width + 0.015, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.55, roughness: 0.32 });
  g.add(new THREE.Mesh(rimGeo, rimMat));

  // Спица для наглядного вращения колеса
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.025, radius * 1.12, 0.055),
    new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.5, roughness: 0.4 })
  );
  g.add(spoke);
  return g;
}

function buildProceduralCar(
  model: ParkedModelKey,
  bodyColor: number,
  isPlayer: boolean,
  shadowTex: THREE.CanvasTexture,
  learnerTex: THREE.CanvasTexture
): CarRig {
  const dim = VEHICLE_DIMS[model];
  const L = dim.length;
  const W = dim.width;
  const H = dim.height;
  const wb = dim.wheelbase;
  const wr = isPlayer ? CAR.wheelRadius : 0.3;
  const ww = isPlayer ? CAR.wheelWidth : 0.2;
  const centerShiftZ = isPlayer ? (CAR.frontOverhang - CAR.rearOverhang) / 2 : 0;

  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  // Контактная тень под кузовом
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.28, L * 1.18),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.set(0, 0.018, centerShiftZ);
  root.add(shadowPlane);

  const paintMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    metalness: 0.35,
    roughness: 0.34,
  });
  const darkTrimMat = new THREE.MeshStandardMaterial({ color: 0x1e252d, roughness: 0.7 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9ec5e6,
    transparent: true,
    opacity: isPlayer ? 0.32 : 0.52,
    roughness: 0.12,
    metalness: 0.25,
  });

  const beltY = 0.84;
  const sillY = 0.26;
  const lowerH = beltY - sillY;

  if (isPlayer) {
    // Полый кузов игрока (инвариант №7: сиденья и водитель внутри, не утоплены в металле)
    const wall = 0.09;
    const cabinLen = wb * 0.88;
    const hoodLen = (L - cabinLen) * 0.54;
    const trunkLen = L - cabinLen - hoodLen;

    // Днище
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W - 0.06, 0.08, L - 0.1), darkTrimMat);
    floor.position.set(0, sillY + 0.04, centerShiftZ);
    chassis.add(floor);

    // Левый (+X) и правый (-X) борта
    for (const side of [1, -1] as const) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(wall, lowerH, cabinLen), paintMat);
      door.position.set(side * (W / 2 - wall / 2), sillY + lowerH / 2, centerShiftZ - 0.06);
      door.castShadow = true;
      chassis.add(door);
    }

    // Передняя часть (капот + бампер)
    const hood = new THREE.Mesh(new THREE.BoxGeometry(W, lowerH * 0.94, hoodLen), paintMat);
    hood.position.set(0, sillY + lowerH * 0.47, centerShiftZ + L / 2 - hoodLen / 2);
    hood.castShadow = true;
    chassis.add(hood);

    // Задняя часть (багажник + бампер)
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(W, lowerH * 0.98, trunkLen), paintMat);
    trunk.position.set(0, sillY + lowerH * 0.49, centerShiftZ - L / 2 + trunkLen / 2);
    trunk.castShadow = true;
    chassis.add(trunk);

    // Торпедо и сиденья
    const dash = new THREE.Mesh(new THREE.BoxGeometry(W - wall * 2.2, 0.26, 0.36), darkTrimMat);
    dash.position.set(0, beltY - 0.04, centerShiftZ + cabinLen * 0.36);
    chassis.add(dash);

    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.85 });
    for (const side of [1, -1] as const) {
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.12), seatMat);
      seatBack.position.set(side * W * 0.24, 0.68, centerShiftZ - 0.14);
      seatBack.rotation.x = -0.14;
      chassis.add(seatBack);
    }

    // Водитель слева (+X, инвариант №2: руль слева +0.36 * halfW)
    const driverX = W * 0.23;
    const driverZ = centerShiftZ - 0.02;
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.46, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.7 })
    );
    torso.position.set(driverX, 0.82, driverZ);
    chassis.add(torso);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xe8be9e, roughness: 0.6 })
    );
    head.position.set(driverX, 1.16, driverZ - 0.01);
    chassis.add(head);

    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.118, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
      new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.8 })
    );
    hair.position.copy(head.position);
    chassis.add(hair);

    // Стойки крыши и крыша
    const roofLen = L * 0.46;
    const roofW = W * 0.82;
    const roofY = H - 0.03;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.055, roofLen), paintMat);
    roof.position.set(0, roofY, centerShiftZ - 0.16);
    roof.castShadow = true;
    chassis.add(roof);

    const pillarOffsets: Array<[number, number, number]> = [
      [roofW / 2 - 0.03, centerShiftZ + roofLen * 0.44, -0.45],
      [-roofW / 2 + 0.03, centerShiftZ + roofLen * 0.44, -0.45],
      [roofW / 2 - 0.03, centerShiftZ - roofLen * 0.55, 0.38],
      [-roofW / 2 + 0.03, centerShiftZ - roofLen * 0.55, 0.38],
    ];
    for (const [px, pz, tilt] of pillarOffsets) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.055, H - beltY + 0.08, 0.065), paintMat);
      p.position.set(px, (beltY + roofY) / 2, pz);
      p.rotation.x = tilt;
      chassis.add(p);
    }

    // Лобовое и заднее стекло
    const windshield = new THREE.Mesh(new THREE.PlaneGeometry(roofW - 0.06, 0.68), glassMat);
    windshield.position.set(0, (beltY + roofY) / 2, centerShiftZ + roofLen * 0.48);
    windshield.rotation.x = -0.58;
    chassis.add(windshield);

    const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(roofW - 0.08, 0.62), glassMat);
    rearGlass.position.set(0, (beltY + roofY) / 2, centerShiftZ - roofLen * 0.62);
    rearGlass.rotation.x = Math.PI + 0.52;
    chassis.add(rearGlass);
  } else {
    // Облегчённый кузов для припаркованных машин (минимум draw calls)
    const lower = new THREE.Mesh(new THREE.BoxGeometry(W, lowerH, L), paintMat);
    lower.position.set(0, sillY + lowerH / 2, 0);
    lower.castShadow = true;
    chassis.add(lower);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.83, H - beltY, L * 0.52), glassMat);
    cabin.position.set(0, beltY + (H - beltY) / 2 - 0.02, -L * 0.05);
    chassis.add(cabin);

    const roofCap = new THREE.Mesh(new THREE.BoxGeometry(W * 0.81, 0.06, L * 0.46), paintMat);
    roofCap.position.set(0, H - 0.02, -L * 0.05);
    roofCap.castShadow = true;
    chassis.add(roofCap);
  }

  // Рулевое колесо в салоне (+X — левая сторона)
  const steerWheelMesh = new THREE.Group();
  steerWheelMesh.position.set(W * 0.23, 0.93, centerShiftZ + 0.48);
  steerWheelMesh.rotation.x = 0.35;
  if (isPlayer) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.02, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5 })
    );
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.045, 0.03),
      new THREE.MeshBasicMaterial({ color: 0xf5b942 })
    );
    marker.position.set(0, 0.17, 0);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.028, 0.022), darkTrimMat);
    steerWheelMesh.add(rim, marker, bar);
    chassis.add(steerWheelMesh);
  }

  // Светотехника: фары, стоп-сигналы, огни заднего хода, поворотники (+X левый, -X правый)
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xdbeafe });
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x7f1d1d });
  const reverseMat = new THREE.MeshBasicMaterial({ color: 0x334155 });
  const blinkLeftMats: THREE.MeshBasicMaterial[] = [];
  const blinkRightMats: THREE.MeshBasicMaterial[] = [];

  const frontZ = centerShiftZ + L / 2 + 0.008;
  const rearZ = centerShiftZ - L / 2 - 0.008;

  for (const side of [1, -1] as const) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.11, 0.03), headlightMat);
    hl.position.set(side * (W * 0.34), 0.66, frontZ);
    chassis.add(hl);

    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.03), brakeMat);
    tl.position.set(side * (W * 0.34), 0.72, rearZ);
    chassis.add(tl);

    if (isPlayer) {
      const rev = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.03), reverseMat);
      rev.position.set(side * (W * 0.2), 0.72, rearZ);
      chassis.add(rev);

      const bMat = new THREE.MeshBasicMaterial({ color: 0x9a621e, toneMapped: false });
      if (side === 1) blinkLeftMats.push(bMat);
      else blinkRightMats.push(bMat);

      // Signal lenses protrude from the body so they remain visible from every camera angle.
      const blinkF = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.07), bMat);
      blinkF.position.set(side * (W * 0.45), 0.66, frontZ + 0.012);
      const blinkR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.07), bMat);
      blinkR.position.set(side * (W * 0.45), 0.75, rearZ - 0.012);
      const mirrorHousing = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.09, 0.11), paintMat);
      mirrorHousing.position.set(side * (W / 2 + 0.06), beltY + 0.06, centerShiftZ + 0.52);
      const blinkSide = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.065, 0.14), bMat);
      blinkSide.position.set(side * (W / 2 + 0.025), 0.88, centerShiftZ + 0.52);
      // Виртуальная боковая камера стоит у стекла, не должна видеть корпус собственного зеркала.
      mirrorHousing.layers.set(OWN_MIRROR_HARDWARE_LAYER);
      blinkSide.layers.set(OWN_MIRROR_HARDWARE_LAYER);
      chassis.add(blinkF, blinkR, mirrorHousing, blinkSide);
    }
  }

  // Прожекторы фар — только у машины игрока (оптимизация v8)
  let headSpotL: THREE.SpotLight | undefined;
  let headSpotR: THREE.SpotLight | undefined;
  let learnerSign: THREE.Mesh | undefined;

  if (isPlayer) {
    const makeSpot = (sx: number) => {
      const sp = new THREE.SpotLight(0xfff6dc, 0, 26, 0.52, 0.55, 1.4);
      sp.position.set(sx, 0.66, frontZ);
      sp.target.position.set(sx * 0.9, 0.05, frontZ + 12);
      chassis.add(sp, sp.target);
      return sp;
    };
    headSpotL = makeSpot(W * 0.34);
    headSpotR = makeSpot(-W * 0.34);

    // Табличка «У» на крыше (0.28 м, перенос из v2)
    const signMat = new THREE.MeshBasicMaterial({ map: learnerTex });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
    learnerSign = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.28, 0.1),
      [sideMat, sideMat, sideMat, sideMat, signMat, signMat]
    );
    learnerSign.position.set(0, H + 0.13, centerShiftZ - 0.12);
    chassis.add(learnerSign);
  }

  // Колёса: передние в поворотных кулаках (Аккерман), задние на оси
  const flPivot = new THREE.Group();
  const frPivot = new THREE.Group();
  const trackHalf = W / 2 - ww * 0.44;
  flPivot.position.set(trackHalf, wr, wb / 2);
  frPivot.position.set(-trackHalf, wr, wb / 2);

  const wFL = createWheelMesh(wr, ww);
  const wFR = createWheelMesh(wr, ww);
  const wRL = createWheelMesh(wr, ww);
  const wRR = createWheelMesh(wr, ww);
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
  };
}

export class SceneController {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly worldGroup = new THREE.Group();
  private readonly buildingMeshes: THREE.Object3D[] = [];
  private readonly signalVisuals: SignalVisual[] = [];
  private readonly pedVisuals: PedestrianVisual[] = [];
  private readonly checkpointMeshes: Array<{ id: string; mesh: THREE.Object3D }> = [];
  private readonly bayVisuals: BayVisual[] = [];
  private readonly playerRig: CarRig;

  // Прогнозная траектория Аккермана
  private readonly trajGroup = new THREE.Group();
  private readonly trajLineL: THREE.Line;
  private readonly trajLineR: THREE.Line;

  // Зеркала (центральное + левое + правое)
  // Заднее зеркало шире и ниже по пропорциям (3.33:1), боковые — выше (2:1), как в реальной машине
  private readonly rearRT: THREE.WebGLRenderTarget;
  private readonly rearCam: THREE.PerspectiveCamera;
  private readonly rearBuf: Uint8Array;
  private readonly sideRT: THREE.WebGLRenderTarget;
  private readonly sideCam: THREE.PerspectiveCamera;
  private readonly sideBuf: Uint8Array;
  // У каждого canvas собственный кадр нужной высоты: остатки 160 строк бокового кадра
  // никогда не попадают в заднее зеркало (96 строк). Буферы переиспользуются, без аллокаций на кадр.
  private readonly mirrorFrames = new WeakMap<HTMLCanvasElement, { ctx: CanvasRenderingContext2D; image: ImageData }>();
  private readonly mirrorLookTarget = new THREE.Vector3();
  /**
   * Three.js рендерит в offscreen-таргет в линейном пространстве и без tone mapping
   * (WebGLRenderer отключает ACES для render target). Без этой конверсии readback
   * зеркала выглядит затемнённым и «тонированным», поэтому применяем linear → sRGB.
   */
  private readonly srgbLut: Uint8Array;
  private frameCounter = 0;

  // Управление орбитальной камерой
  private orbitYaw = 0;
  private orbitPitch = 0.36;
  private orbitDist = 9.2;
  private camLookTarget = new THREE.Vector3();

  // Общие текстуры (освобождаются при dispose)
  private readonly sharedTextures: THREE.Texture[] = [];

  // Метрики производительности (FPS и p95 кадра)
  private readonly frameTimes: number[] = [];
  private lastPerfSample = performance.now();
  private visibleBuildings = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    const skyTex = makeSkyTexture();
    const shadowTex = makeContactShadowTexture();
    const learnerTex = makeLearnerSignTexture();
    this.sharedTextures.push(skyTex, shadowTex, learnerTex);
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog(0xbcd3e6, 75, 220);

    this.camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.12, 420);

    // Освещение
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x3b493f, 0.85);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff6e5, 1.35);
    this.sun.position.set(28, 46, -22);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 5;
    this.sun.shadow.camera.far = 160;
    const d = 42;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.scene.add(this.sun, this.sun.target);

    // Травяная подложка
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1400),
      new THREE.MeshStandardMaterial({ color: 0x3f5743, roughness: 0.96 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(this.worldGroup);

    // Машина игрока Kia Ceed
    this.playerRig = buildProceduralCar("ceed", 0xd97706, true, shadowTex, learnerTex);
    this.playerRig.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && !obj.layers.isEnabled(OWN_MIRROR_HARDWARE_LAYER)) {
        obj.layers.set(PLAYER_EXTERIOR_LAYER);
      }
    });
    // Основной вид сохраняет всю машину, включая зеркала, водителя и светотехнику.
    this.camera.layers.enable(PLAYER_EXTERIOR_LAYER);
    this.camera.layers.enable(OWN_MIRROR_HARDWARE_LAYER);
    this.scene.add(this.playerRig.root);

    // Линии прогнозной траектории Аккермана
    const makeTrajLine = () =>
      new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x52d6bd, transparent: true, opacity: 0.9 })
      );
    this.trajLineL = makeTrajLine();
    this.trajLineR = makeTrajLine();
    this.trajGroup.add(this.trajLineL, this.trajLineR);
    this.scene.add(this.trajGroup);

    // Заднее: 10:3, боковые: 2:1. Задняя камера видит мир без пересечения крыши/салона;
    // боковые дополнительно видят наружную кромку автомобиля, но не корпуса зеркал.
    this.rearRT = new THREE.WebGLRenderTarget(320, 96, { depthBuffer: true });
    this.rearCam = new THREE.PerspectiveCamera(38, 320 / 96, 0.06, 130);
    this.rearBuf = new Uint8Array(320 * 96 * 4);
    this.sideRT = new THREE.WebGLRenderTarget(320, 160, { depthBuffer: true });
    this.sideCam = new THREE.PerspectiveCamera(44, 320 / 160, 0.06, 130);
    this.sideBuf = new Uint8Array(320 * 160 * 4);
    this.sideCam.layers.enable(PLAYER_EXTERIOR_LAYER);

    // LUT linear → sRGB с небольшим усилением экспозиции
    this.srgbLut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const linear = i / 255;
      const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
      this.srgbLut[i] = Math.round(clamp(srgb * 1.12, 0, 1) * 255);
    }
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  adjustOrbit(deltaX: number, deltaY: number): void {
    this.orbitYaw -= deltaX * 0.0065;
    this.orbitPitch = clamp(this.orbitPitch + deltaY * 0.005, 0.12, 1.38);
  }

  adjustZoom(wheelDelta: number): void {
    this.orbitDist = clamp(this.orbitDist * (1 + wheelDelta * 0.0009), 4.6, 42);
  }

  resetOrbit(): void {
    this.orbitYaw = 0;
    this.orbitPitch = 0.36;
    this.orbitDist = 9.2;
  }

  applyQuality(preset: QualityPreset): void {
    if (preset === "low") {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
    } else if (preset === "medium") {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.shadowMap.enabled = true;
      this.sun.shadow.mapSize.set(1024, 1024);
    } else {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.sun.shadow.mapSize.set(2048, 2048);
    }
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /** Перестраивает 3D-геометрию мира при смене сценария или размеров бокса, освобождая старые ресурсы. */
  loadWorld(world: WorldData): void {
    this.disposeGroup(this.worldGroup);
    this.buildingMeshes.length = 0;
    this.signalVisuals.length = 0;
    this.pedVisuals.length = 0;
    this.checkpointMeshes.length = 0;
    this.bayVisuals.length = 0;

    const asphaltTex = makeAsphaltTexture();
    const winTex = makeBuildingWindowTexture();
    const shadowTex = this.sharedTextures[1] as THREE.CanvasTexture;
    const learnerTex = this.sharedTextures[2] as THREE.CanvasTexture;
    const asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.92 });
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x5c6670, roughness: 0.9 });
    const whiteMarkMat = new THREE.MeshBasicMaterial({ color: 0xf1f5f9 });

    // Дороги и разметка
    for (const road of world.roads) {
      for (let i = 0; i < road.points.length - 1; i++) {
        const p0 = road.points[i];
        const p1 = road.points[i + 1];
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const angle = Math.atan2(dx, dz);
        const mx = (p0.x + p1.x) / 2;
        const mz = (p0.z + p1.z) / 2;

        // Тротуар-подложка для городских улиц
        if (world.scenarioId === "city_osm") {
          const sw = new THREE.Mesh(
            new THREE.PlaneGeometry(road.width + 3.2, len + road.width * 0.4),
            sidewalkMat
          );
          sw.rotation.order = "YXZ";
          sw.rotation.y = angle;
          sw.rotation.x = -Math.PI / 2;
          sw.position.set(mx, 0.005, mz);
          sw.receiveShadow = true;
          this.worldGroup.add(sw);
        }

        const seg = new THREE.Mesh(
          new THREE.PlaneGeometry(road.width, len + (world.scenarioId === "city_osm" ? road.width : 0)),
          asphaltMat
        );
        seg.rotation.order = "YXZ";
        seg.rotation.y = angle;
        seg.rotation.x = -Math.PI / 2;
        seg.position.set(mx, 0.012, mz);
        seg.receiveShadow = true;
        this.worldGroup.add(seg);

        // Осевая разметка (1.1 сплошная или 1.5 прерывистая)
        if (road.lanes >= 2 && len > 8) {
          if (road.hasSolidCenter) {
            const line = new THREE.Mesh(new THREE.PlaneGeometry(0.14, len - 8), whiteMarkMat);
            line.rotation.order = "YXZ";
            line.rotation.y = angle;
            line.rotation.x = -Math.PI / 2;
            line.position.set(mx, 0.022, mz);
            this.worldGroup.add(line);
          } else {
            const dashCount = Math.floor(len / 5);
            for (let k = 0; k < dashCount; k++) {
              const t = (k + 0.5) / dashCount;
              const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 2.2), whiteMarkMat);
              dash.rotation.order = "YXZ";
              dash.rotation.y = angle;
              dash.rotation.x = -Math.PI / 2;
              dash.position.set(p0.x + dx * t, 0.022, p0.z + dz * t);
              this.worldGroup.add(dash);
            }
          }
        }
      }
    }

    // Парковочные боксы (перпендикулярные и параллельные)
    for (const bay of world.bays) {
      const bayGroup = new THREE.Group();
      bayGroup.position.set(bay.cx, 0.024, bay.cz);
      bayGroup.rotation.y = bay.h;

      // Асфальтовый карман для городских параллельных мест
      if (world.scenarioId === "city_osm") {
        const pocket = new THREE.Mesh(new THREE.PlaneGeometry(bay.width + 0.6, bay.length + 0.6), asphaltMat);
        pocket.rotation.x = -Math.PI / 2;
        pocket.position.y = -0.01;
        bayGroup.add(pocket);
      }

      const lineMat = new THREE.MeshBasicMaterial({
        color: bay.occupied ? 0x94a3b8 : 0xf8fafc,
      });
      const lw = 0.11;
      const addStrip = (w: number, l: number, x: number, z: number) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0, z);
        bayGroup.add(m);
      };

      // Левая, правая, передняя, задняя линии (открытая сторона — пунктир)
      if (bay.openSide === "front") {
        addStrip(lw, bay.length, bay.width / 2, 0);
        addStrip(lw, bay.length, -bay.width / 2, 0);
        addStrip(bay.width + lw, lw, 0, -bay.length / 2);
        // Пунктирная линия въезда
        for (const ox of [-0.65, 0, 0.65]) {
          addStrip(0.32, lw * 0.85, ox, bay.length / 2);
        }
      } else {
        // Параллельный карман: открыт слева (+X)
        addStrip(lw, bay.length, -bay.width / 2, 0);
        addStrip(bay.width, lw, 0, bay.length / 2);
        addStrip(bay.width, lw, 0, -bay.length / 2);
        for (const oz of [-bay.length * 0.3, 0, bay.length * 0.3]) {
          addStrip(lw * 0.9, 0.7, bay.width / 2, oz);
        }
      }

      // Номер бокса на асфальте
      const numTex = makeBayNumberTexture(bay.id, bay.occupied);
      const numPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.15, 1.15),
        new THREE.MeshBasicMaterial({ map: numTex, transparent: true, depthWrite: false })
      );
      numPlane.rotation.x = -Math.PI / 2;
      numPlane.position.set(0, 0.004, bay.kind === "perpendicular" ? bay.length * 0.22 : 0);
      bayGroup.add(numPlane);

      this.worldGroup.add(bayGroup);
      if (!bay.occupied) {
        this.bayVisuals.push({ bay, lineMat });
      }
    }

    // Препятствия: припаркованные машины, бордюры, конусы, здания
    for (const obs of world.obstacles) {
      this.addObstacleMesh(obs, winTex, shadowTex, learnerTex);
    }

    // Светофоры и стоп-линии 1.12
    for (const sig of world.signals) {
      this.addTrafficSignal(sig, whiteMarkMat);
    }

    // Пешеходные переходы «зебра» и пешеходы
    for (const cw of world.crosswalks) {
      const cwGroup = new THREE.Group();
      cwGroup.position.set(cw.cx, 0.026, cw.cz);
      cwGroup.rotation.y = cw.h;
      const stripes = Math.floor(cw.width / 0.95);
      for (let i = 0; i < stripes; i++) {
        const sx = ((i + 0.5) / stripes - 0.5) * (cw.width - 0.8);
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.46, cw.length), whiteMarkMat);
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(sx, 0, 0);
        cwGroup.add(stripe);
      }
      // Знак 5.19 «Пешеходный переход» справа от дороги
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 2.5, 8),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8 })
      );
      pole.position.set(-cw.width / 2 - 0.9, 1.25, -cw.length / 2 - 0.5);
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.55, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x2563eb })
      );
      board.position.set(-cw.width / 2 - 0.9, 2.45, -cw.length / 2 - 0.5);
      cwGroup.add(pole, board);
      this.worldGroup.add(cwGroup);

      // Фигура пешехода
      const ped = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.36, 0.58, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.65 })
      );
      body.position.y = 1.05;
      body.castShadow = true;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xf1c7a3 })
      );
      head.position.y = 1.5;
      const legGeo = new THREE.BoxGeometry(0.13, 0.68, 0.14);
      const legMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
      const legL = new THREE.Mesh(legGeo, legMat);
      legL.position.set(0.09, 0.38, 0);
      const legR = new THREE.Mesh(legGeo, legMat);
      legR.position.set(-0.09, 0.38, 0);
      ped.add(body, head, legL, legR);
      this.worldGroup.add(ped);
      this.pedVisuals.push({ crosswalkId: cw.id, group: ped, legL, legR });
    }

    // Знаки ограничения скорости 3.24
    for (const sz of world.speedZones) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 2.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8 })
      );
      pole.position.set(sz.signX, 1.3, sz.signZ);
      const signTex = makeSpeedSignTexture(sz.limitKmh);
      const disc = new THREE.Mesh(
        new THREE.PlaneGeometry(0.68, 0.68),
        new THREE.MeshBasicMaterial({ map: signTex, transparent: true, side: THREE.DoubleSide })
      );
      disc.position.set(sz.signX, 2.55, sz.signZ);
      this.worldGroup.add(pole, disc);
    }

    // Контрольные точки маршрута (янтарные маркеры на дороге)
    for (const cp of world.checkpoints) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.85, 28),
        new THREE.MeshBasicMaterial({
          color: cp.isFinalPark ? 0x52d6bd : 0xf5b942,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.78,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cp.x, 0.04, cp.z);
      this.worldGroup.add(ring);
      this.checkpointMeshes.push({ id: cp.id, mesh: ring });
    }

    // Лёгкие декоративные деревья за пределами проезжей части
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4029, roughness: 0.9 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f6a44, roughness: 0.85 });
    const treeCoords: Array<[number, number]> =
      world.scenarioId === "city_osm"
        ? [
            [-9, -42], [9, -38], [-9, -18], [9, 18], [-9, 44], [9, 48],
            [-18, 56], [-42, 72], [-70, 72], [28, -9], [-28, -9],
          ]
        : [
            [-13, -8], [13, -8], [-13, 13], [13, 13], [0, -14], [0, 18],
          ];
    for (const [tx, tz] of treeCoords) {
      const tg = new THREE.Group();
      tg.position.set(tx, 0, tz);
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.8, 7), trunkMat);
      tr.position.y = 0.9;
      const cr = new THREE.Mesh(new THREE.DodecahedronGeometry(1.45, 0), crownMat);
      cr.position.y = 2.65;
      tg.add(tr, cr);
      this.worldGroup.add(tg);
    }

    this.resetOrbit();
    this.camLookTarget.set(world.start.x, 1.0, world.start.z);
  }

  private addObstacleMesh(
    obs: ObstacleBox,
    winTex: THREE.CanvasTexture,
    shadowTex: THREE.CanvasTexture,
    learnerTex: THREE.CanvasTexture
  ): void {
    if (obs.kind === "parked_car" && obs.model) {
      const rig = buildProceduralCar(obs.model, obs.color ?? 0x94a3b8, false, shadowTex, learnerTex);
      rig.root.position.set(obs.cx, 0, obs.cz);
      rig.root.rotation.y = obs.h;
      this.worldGroup.add(rig.root);
      return;
    }

    if (obs.kind === "cone") {
      const g = new THREE.Group();
      g.position.set(obs.cx, 0, obs.cz);
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, 0.05, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x1e293b })
      );
      base.position.y = 0.025;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, obs.height, 10),
        new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.5 })
      );
      cone.position.y = obs.height / 2 + 0.03;
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.065, 0.088, 0.11, 10),
        new THREE.MeshBasicMaterial({ color: 0xf8fafc })
      );
      band.position.y = obs.height * 0.62;
      g.add(base, cone, band);
      this.worldGroup.add(g);
      return;
    }

    if (obs.kind === "building") {
      const mat = new THREE.MeshStandardMaterial({
        color: obs.color ?? 0x556472,
        map: winTex,
        roughness: 0.82,
      });
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(obs.halfX * 2, obs.height, obs.halfZ * 2),
        mat
      );
      mesh.position.set(obs.cx, obs.height / 2, obs.cz);
      mesh.rotation.y = obs.h;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.worldGroup.add(mesh);
      this.buildingMeshes.push(mesh);
      return;
    }

    // Бордюр или столб
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(obs.halfX * 2, obs.height, obs.halfZ * 2),
      new THREE.MeshStandardMaterial({ color: obs.color ?? 0x9aa6b2, roughness: 0.85 })
    );
    mesh.position.set(obs.cx, obs.height / 2, obs.cz);
    mesh.rotation.y = obs.h;
    mesh.receiveShadow = true;
    this.worldGroup.add(mesh);
  }

  private addTrafficSignal(sig: TrafficSignalDef, whiteMat: THREE.MeshBasicMaterial): void {
    // Стоп-линия 1.12
    const stopLine = new THREE.Mesh(new THREE.PlaneGeometry(sig.stopLineWidth, 0.42), whiteMat);
    stopLine.rotation.order = "YXZ";
    stopLine.rotation.y = sig.h;
    stopLine.rotation.x = -Math.PI / 2;
    stopLine.position.set(sig.stopLineX, 0.028, sig.stopLineZ);
    this.worldGroup.add(stopLine);

    // Опора и головка светофора (обращена к подъезжающему водителю)
    const g = new THREE.Group();
    g.position.set(sig.x, 0, sig.z);
    g.rotation.y = sig.h;

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.065, 0.075, 3.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.4 })
    );
    pole.position.y = 1.8;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 1.08, 0.24),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 })
    );
    box.position.y = 3.55;

    const redMat = new THREE.MeshBasicMaterial({ color: 0x3b0d0d });
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0x3b2f08 });
    const greenMat = new THREE.MeshBasicMaterial({ color: 0x09381f });

    const lensGeo = new THREE.CircleGeometry(0.125, 14);
    const makeLens = (mat: THREE.MeshBasicMaterial, y: number) => {
      const m = new THREE.Mesh(lensGeo, mat);
      m.position.set(0, y, -0.126); // смотрит к -Z (навстречу потоку +Z)
      m.rotation.y = Math.PI;
      return m;
    };
    g.add(pole, box, makeLens(redMat, 3.88), makeLens(yellowMat, 3.55), makeLens(greenMat, 3.22));
    this.worldGroup.add(g);
    this.signalVisuals.push({ def: sig, redMat, yellowMat, greenMat });
  }

  /** Отрисовывает кадр и (опционально) зеркала заднего/бокового вида. */
  render(
    state: SimState,
    world: WorldData,
    isBraking: boolean,
    opts: RenderOptions,
    mirrors?: {
      rear: HTMLCanvasElement | null;
      left: HTMLCanvasElement | null;
      right: HTMLCanvasElement | null;
    }
  ): void {
    const now = performance.now();
    const dtMs = now - this.lastPerfSample;
    this.lastPerfSample = now;
    if (dtMs > 0 && dtMs < 250) {
      this.frameTimes.push(dtMs);
      if (this.frameTimes.length > 120) this.frameTimes.shift();
    }

    // 1. Синхронизация автомобиля игрока
    const rig = this.playerRig;
    rig.root.position.set(state.x, 0, state.z);
    rig.root.rotation.y = state.h;
    rig.chassis.rotation.x = state.pitch;
    rig.chassis.rotation.z = state.roll;

    // Геометрия Аккермана на передних колёсах
    rig.flPivot.rotation.y = state.steerLeft;
    rig.frPivot.rotation.y = state.steerRight;
    for (const wm of rig.wheelMeshes) wm.rotation.x = state.wheelSpin;
    rig.steerWheelMesh.rotation.z = -(state.swDeg * Math.PI) / 180;

    if (rig.learnerSign) rig.learnerSign.visible = opts.showLearnerSign;

    // Поворотники (период 700 мс, как в v8)
    const { blinkOn, leftLit, rightLit } = getTurnSignalFlash(state.signal, state.time);
    for (const m of rig.blinkLeftMats) m.color.setHex(leftLit ? 0xffb020 : 0x9a621e);
    for (const m of rig.blinkRightMats) m.color.setHex(rightLit ? 0xffb020 : 0x9a621e);

    rig.brakeMat.color.setHex(isBraking || state.handbrake ? 0xff2a2a : state.lights ? 0xb91c1c : 0x6b1515);
    rig.reverseMat.color.setHex(state.gear === "R" && state.engineOn ? 0xf8fafc : 0x334155);
    rig.headlightMat.color.setHex(state.lights && state.engineOn ? 0xfffbeb : 0x94a3b8);
    if (rig.headSpotL && rig.headSpotR) {
      const inten = state.lights && state.engineOn ? 1.8 : 0;
      rig.headSpotL.intensity = inten;
      rig.headSpotR.intensity = inten;
    }

    // Подвижная тень солнца вокруг автомобиля
    this.sun.position.set(state.x + 26, 44, state.z - 20);
    this.sun.target.position.set(state.x, 0, state.z);

    // 2. Отсечение дальних зданий по радиусу (оптимизация под школьные ПК)
    const r2 = opts.drawRadius * opts.drawRadius;
    let vis = 0;
    for (const bm of this.buildingMeshes) {
      const dx = bm.position.x - state.x;
      const dz = bm.position.z - state.z;
      const show = dx * dx + dz * dz <= r2;
      bm.visible = show;
      if (show) vis++;
    }
    this.visibleBuildings = vis;

    // 3. Подсветка линий свободных боксов
    for (const bv of this.bayVisuals) {
      if (state.finishedBayId === bv.bay.id) {
        bv.lineMat.color.setHex(0x52d6bd);
      } else if (state.inLineCross && state.activeBayId === bv.bay.id) {
        bv.lineMat.color.setHex(0xff5c5c);
      } else if (state.holdTime > 0 && state.activeBayId === bv.bay.id) {
        bv.lineMat.color.setHex(0x86efac);
      } else if (state.activeBayId === bv.bay.id) {
        bv.lineMat.color.setHex(0xf5b942);
      } else {
        bv.lineMat.color.setHex(0xf8fafc);
      }
    }

    // 4. Светофоры, пешеходы и контрольные точки
    for (const sv of this.signalVisuals) {
      const { phase } = getTrafficLightPhase(sv.def, state.time);
      const redOn = phase === "red" || phase === "red_yellow";
      const yelOn = phase === "yellow" || phase === "red_yellow";
      const grnOn = phase === "green" || (phase === "green_blink" && blinkOn);
      sv.redMat.color.setHex(redOn ? 0xff3b3b : 0x3b0d0d);
      sv.yellowMat.color.setHex(yelOn ? 0xffcc29 : 0x3b2f08);
      sv.greenMat.color.setHex(grnOn ? 0x22e584 : 0x09381f);
    }

    for (let i = 0; i < this.pedVisuals.length; i++) {
      const pv = this.pedVisuals[i];
      const cw = world.crosswalks[i];
      if (!cw) continue;
      const pose = getPedestrianPose(cw, state.time);
      pv.group.position.set(pose.x, 0, pose.z);
      pv.group.rotation.y = pose.h;
      const swing = Math.sin(pose.walkPhase) * 0.42;
      pv.legL.rotation.x = swing;
      pv.legR.rotation.x = -swing;
    }

    const activeCp = world.checkpoints[state.currentCheckpointIndex];
    for (const cm of this.checkpointMeshes) {
      const done = state.completedCheckpointIds.includes(cm.id);
      cm.mesh.visible = !done;
      if (activeCp && cm.id === activeCp.id) {
        const pulse = 1 + Math.sin(state.time * 4) * 0.12;
        cm.mesh.scale.set(pulse, pulse, 1);
      } else {
        cm.mesh.scale.set(1, 1, 1);
      }
    }

    // 5. Прогнозная дуга траектории Аккермана
    this.trajGroup.visible = opts.showTrajectory;
    if (opts.showTrajectory) {
      const isRev = state.gear === "R";
      const { leftTrack, rightTrack } = predictTrajectoryArc(state.x, state.z, state.h, state.steer, isRev, 6.2, 18);
      const setPts = (line: THREE.Line, pts: Array<{ x: number; z: number }>, colorHex: number) => {
        const arr = new Float32Array(pts.length * 3);
        pts.forEach((p, idx) => {
          arr[idx * 3] = p.x;
          arr[idx * 3 + 1] = 0.06;
          arr[idx * 3 + 2] = p.z;
        });
        line.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        (line.material as THREE.LineBasicMaterial).color.setHex(colorHex);
      };
      const col = isRev ? 0xf5b942 : 0x52d6bd;
      setPts(this.trajLineL, leftTrack, col);
      setPts(this.trajLineR, rightTrack, col);
    }

    // 6. Камера
    this.updateCamera(state, opts.cameraMode);

    // 7. Зеркала (без пересчёта карты теней, боковые раз в 3 кадра)
    this.frameCounter++;
    if (mirrors && (opts.showMirrors || opts.showRearMirror)) {
      const prevShadowAuto = this.renderer.shadowMap.autoUpdate;
      this.renderer.shadowMap.autoUpdate = false;
      try {
        this.playerRig.chassis.updateWorldMatrix(true, false);
        if (opts.showRearMirror && mirrors.rear && this.frameCounter % 2 === 0) {
          this.renderInto(this.rearRT, this.rearCam, this.rearBuf, 0, 1.24, 0.25, 0, -0.08, 38, mirrors.rear);
        }
        // Камеры направлены назад и наружу: +X слева, −X справа. Не «смотрят» сквозь дверь.
        const mountX = CAR.width / 2 + 0.14;
        if (opts.showMirrors && mirrors.left && this.frameCounter % 3 === 0) {
          this.renderInto(this.sideRT, this.sideCam, this.sideBuf, mountX, 0.92, 0.49, -0.53, -0.10, 44, mirrors.left);
        }
        if (opts.showMirrors && mirrors.right && this.frameCounter % 3 === 1) {
          this.renderInto(this.sideRT, this.sideCam, this.sideBuf, -mountX, 0.92, 0.49, 0.53, -0.10, 44, mirrors.right);
        }
      } finally {
        this.renderer.shadowMap.autoUpdate = prevShadowAuto;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  private renderInto(
    rt: THREE.WebGLRenderTarget,
    cam: THREE.PerspectiveCamera,
    buf: Uint8Array,
    localX: number,
    localY: number,
    localZ: number,
    yawOffset: number,
    pitchDown: number,
    fov: number,
    targetCanvas: HTMLCanvasElement
  ): void {
    const w = rt.width;
    const h = rt.height;
    let frame = this.mirrorFrames.get(targetCanvas);
    if (!frame || frame.image.width !== w || frame.image.height !== h) {
      targetCanvas.width = w;
      targetCanvas.height = h;
      const ctx = targetCanvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      frame = { ctx, image: ctx.createImageData(w, h) };
      this.mirrorFrames.set(targetCanvas, frame);
    }

    // Камеры закреплены относительно кузова: наклон и крен при манёвре совпадают с машиной.
    const pose = this.playerRig.chassis.matrixWorld;
    const yaw = Math.PI + yawOffset;
    if (cam.fov !== fov || cam.aspect !== w / h) {
      cam.fov = fov;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    cam.position.set(localX, localY, localZ).applyMatrix4(pose);
    cam.up.set(0, 1, 0).transformDirection(pose);
    cam.lookAt(this.mirrorLookTarget.set(
      localX + Math.sin(yaw), localY + pitchDown, localZ + Math.cos(yaw)
    ).applyMatrix4(pose));

    const previous = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, cam);
      this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    } finally {
      this.renderer.setRenderTarget(previous);
    }

    // Readback идёт снизу вверх. Обратный обход пикселей одновременно переворачивает Y
    // и зеркалит X. Вывод строго 1:1: без общего промежуточного холста и растягивания.
    const dst = frame.image.data;
    const lut = this.srgbLut;
    for (let to = 0, from = buf.length - 4; to < dst.length; to += 4, from -= 4) {
      dst[to] = lut[buf[from]];
      dst[to + 1] = lut[buf[from + 1]];
      dst[to + 2] = lut[buf[from + 2]];
      dst[to + 3] = 255;
    }
    frame.ctx.putImageData(frame.image, 0, 0);
  }

  private updateCamera(s: SimState, mode: CameraMode): void {
    const fx = Math.sin(s.h);
    const fz = Math.cos(s.h);
    const lx = Math.cos(s.h);
    const lz = -Math.sin(s.h);

    if (mode === "cockpit") {
      // Водительское место слева (+X)
      const eyeX = s.x + lx * (CAR.width * 0.23) - fx * 0.02;
      const eyeY = 1.19;
      const eyeZ = s.z + lz * (CAR.width * 0.23) - fz * 0.02;
      const lookYaw = s.h + this.orbitYaw * 0.65;
      this.camera.fov = 64;
      this.camera.updateProjectionMatrix();
      this.camera.position.set(eyeX, eyeY, eyeZ);
      this.camera.lookAt(
        eyeX + Math.sin(lookYaw) * 18,
        eyeY - 0.12 - (this.orbitPitch - 0.36) * 6,
        eyeZ + Math.cos(lookYaw) * 18
      );
      return;
    }

    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();

    if (mode === "top") {
      // Вид инструктора сверху (вперёд машины — вверх экрана)
      const height = clamp(this.orbitDist * 2.1, 13, 48);
      this.camera.position.set(s.x - fx * 0.8, height, s.z - fz * 0.8);
      this.camera.lookAt(s.x + fx * 0.4, 0, s.z + fz * 0.4);
      return;
    }

    const angle = mode === "orbit" ? s.h + this.orbitYaw : s.h + this.orbitYaw * 0.85;
    const dist = this.orbitDist;
    const pitch = this.orbitPitch;
    const horiz = Math.cos(pitch) * dist;
    const desiredPos = new THREE.Vector3(
      s.x - Math.sin(angle) * horiz,
      Math.max(1.1, Math.sin(pitch) * dist + 0.8),
      s.z - Math.cos(angle) * horiz
    );
    const lerpK = mode === "orbit" ? 0.35 : 0.16;
    this.camera.position.lerp(desiredPos, lerpK);
    this.camLookTarget.lerp(new THREE.Vector3(s.x + fx * 1.1, 0.95, s.z + fz * 1.1), 0.22);
    this.camera.lookAt(this.camLookTarget);
  }

  getPerfMetrics(): PerfMetrics {
    if (this.frameTimes.length === 0) {
      return {
        fps: 60,
        p95FrameMs: 16.6,
        visibleBuildings: this.visibleBuildings,
        totalBuildings: this.buildingMeshes.length,
      };
    }
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      fps: Math.round(1000 / Math.max(1, avg)),
      p95FrameMs: Number(p95.toFixed(1)),
      visibleBuildings: this.visibleBuildings,
      totalBuildings: this.buildingMeshes.length,
    };
  }

  private disposeGroup(group: THREE.Group): void {
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of list) {
          materials.add(m);
          const std = m as THREE.MeshStandardMaterial;
          if (std.map && !this.sharedTextures.includes(std.map)) textures.add(std.map);
        }
      }
    });
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    group.clear();
  }

  dispose(): void {
    this.disposeGroup(this.worldGroup);
    this.disposeGroup(this.playerRig.root);
    this.trajLineL.geometry.dispose();
    (this.trajLineL.material as THREE.Material).dispose();
    this.trajLineR.geometry.dispose();
    (this.trajLineR.material as THREE.Material).dispose();
    this.rearRT.dispose();
    this.sideRT.dispose();
    this.sharedTextures.forEach((t) => t.dispose());
    this.renderer.dispose();
  }
}
