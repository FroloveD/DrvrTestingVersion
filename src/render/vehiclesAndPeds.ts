/**
 * @module render/vehiclesAndPeds
 * @layer three-render
 * @role Процедурные 3D-модели учебного Kia Ceed JD (кузов, оптика, диски, госномера ГОСТ Р 50577, салон и приборы), припаркованного автопарка и анимированных пешеходов.
 * @invariants #1 (координаты +Z вперёд, +X левый борт), #2 (левый руль +X, синхронные поворотники), #8 (офлайн), #13 (слои зеркал).
 * @tests Смоук A, L, M, O (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { ParkedModelKey } from "../sim/types";
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
  /** Силуэт водителя (виден снаружи, скрывается в режиме камеры из салона). */
  driverGroup?: THREE.Group;
};

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

/** Строит детализированный учебный Kia Ceed JD (`isPlayer = true`) или автомобиль припаркованного автопарка. */
export function buildDetailedCar(
  model: ParkedModelKey,
  bodyColor: number,
  isPlayer: boolean,
  shadowTex: THREE.CanvasTexture,
  learnerTex: THREE.CanvasTexture,
  plateTex: THREE.CanvasTexture,
  clusterTex: THREE.CanvasTexture,
  mirrorHardwareLayer: number
): DetailedCarRig {
  const dim = VEHICLE_DIMS[model];
  const L = dim.length;
  const W = dim.width;
  const H = dim.height;
  const wb = dim.wheelbase;
  const wr = isPlayer ? CAR.wheelRadius : model === "sorento" ? 0.35 : 0.3;
  const ww = isPlayer ? CAR.wheelWidth : 0.205;
  const centerShiftZ = isPlayer ? (CAR.frontOverhang - CAR.rearOverhang) / 2 : 0;

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

  const paintMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    metalness: 0.44,
    roughness: 0.26,
  });
  const darkTrimMat = new THREE.MeshStandardMaterial({ color: 0x1b2129, roughness: 0.72, metalness: 0.12 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.82, roughness: 0.18 });
  const plateMat = new THREE.MeshBasicMaterial({ map: plateTex });
  const glassMat = new THREE.MeshStandardMaterial({
    color: isPlayer ? 0x9ec5e6 : 0x2f4358,
    transparent: true,
    opacity: isPlayer ? 0.28 : 0.72,
    roughness: 0.1,
    metalness: 0.35,
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

    // Задний модуль хэтчбека + чёрный диффузор + хромированный выхлоп
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, lowerH * 0.98, trunkLen), paintMat);
    trunk.position.set(0, sillY + lowerH * 0.49, rearFaceZ + trunkLen / 2);
    trunk.castShadow = true;
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

    // Детализированный салон: торпедо, козырёк и шкалы приборов Supervision, ШГУ, тоннель АКПП, кресла и водитель
    const dashZ = centerShiftZ + cabinLen * 0.35;
    const dash = new THREE.Mesh(new THREE.BoxGeometry(W - wall * 2.1, 0.24, 0.38), darkTrimMat);
    dash.position.set(0, beltY - 0.055, dashZ + 0.02);
    const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.24), darkTrimMat);
    binnacle.position.set(W * 0.23, beltY + 0.11, dashZ - 0.02);
    const cluster = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.12),
      new THREE.MeshBasicMaterial({ map: clusterTex })
    );
    cluster.position.set(W * 0.23, beltY + 0.09, dashZ - 0.145);
    cluster.rotation.y = Math.PI;
    const headUnit = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.12),
      new THREE.MeshBasicMaterial({ color: 0x172b3a })
    );
    headUnit.position.set(0, beltY + 0.02, dashZ - 0.176);
    headUnit.rotation.y = Math.PI;
    const consoleTunnel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.92), darkTrimMat);
    consoleTunnel.position.set(0, sillY + 0.16, centerShiftZ + 0.18);
    chassis.add(dash, binnacle, cluster, headUnit, consoleTunnel);

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

      // Внутренняя обшивка передних дверей с подлокотником и хромированной ручкой
      const doorCard = new THREE.Mesh(new THREE.BoxGeometry(0.028, lowerH - 0.08, cabinLen * 0.48), doorCardMat);
      doorCard.position.set(side * (W / 2 - wall - 0.012), sillY + 0.06 + (lowerH - 0.08) / 2, centerShiftZ + 0.36);
      const armrest = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.045, 0.42), darkTrimMat);
      armrest.position.set(side * (W / 2 - wall - 0.032), beltY - 0.16, centerShiftZ + 0.3);
      const innerPull = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.024, 0.09), chromeMat);
      innerPull.position.set(side * (W / 2 - wall - 0.028), beltY - 0.09, centerShiftZ + 0.48);
      // Сложенный солнцезащитный козырёк под кромкой потолка (не перекрывает обзор)
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.018, 0.13), seatMat);
      visor.position.set(side * 0.36, roofY - 0.034, centerShiftZ + roofLen * 0.4 - 0.03);
      visor.rotation.x = 0.08;
      chassis.add(cushion, seatBack, headrest, doorCard, armrest, innerPull, visor);
    }

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

  // Трёхспицевое рулевое колесо в салоне (+X — левая сторона)
  const steerWheelMesh = new THREE.Group();
  steerWheelMesh.position.set(W * 0.23, 0.92, centerShiftZ + 0.48);
  steerWheelMesh.rotation.x = 0.35;
  if (isPlayer) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.021, 10, 24),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.45 })
    );
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.066, 0.04, 14), darkTrimMat);
    hub.rotation.x = Math.PI / 2;
    const barH = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.03, 0.022), darkTrimMat);
    const barV = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.15, 0.022), darkTrimMat);
    barV.position.y = -0.085;
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.046, 0.032),
      new THREE.MeshBasicMaterial({ color: 0xf5b942 })
    );
    marker.position.set(0, 0.17, 0);
    steerWheelMesh.add(rim, hub, barH, barV, marker);
    chassis.add(steerWheelMesh);
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
