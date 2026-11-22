/**
 * @module render/cityBuildings
 * @layer three-render
 * @role Текстурированные коробочные здания на статических офлайн-ассетах, многоярусные деревья (вкл. берёзы) и облачное небо.
 * @invariants #8 (100 % офлайн — ноль внешних ассетов), #13 (полностью статично для стабильности зеркал).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ObstacleBox } from "../sim/types";
import facadeTextureUrl from "../assets/buildings/facade.svg?url";
import roofTextureUrl from "../assets/buildings/roof.svg?url";

export type CityEnvironmentPack = {
  facadeMat: THREE.MeshStandardMaterial;
  roofMat: THREE.MeshStandardMaterial;
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
export function makeCloudySkyTexture(equirectangular = true): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;

  const grad = g.createLinearGradient(0, 0, 0, h);
  if (equirectangular) {
    grad.addColorStop(0, "#24558b");
    grad.addColorStop(0.18, "#447db6");
    grad.addColorStop(0.35, "#7cb0da");
    grad.addColorStop(0.46, "#bdd8ec");
    grad.addColorStop(0.5, "#dce9f3");
    grad.addColorStop(0.53, "#bcc8ce");
    grad.addColorStop(0.66, "#6f7b78");
    grad.addColorStop(1, "#3f4847");
  } else {
    grad.addColorStop(0, "#2f6299");
    grad.addColorStop(0.36, "#5d93c6");
    grad.addColorStop(0.68, "#9ec3e2");
    grad.addColorStop(0.88, "#cde0ef");
    grad.addColorStop(1, "#e2ecf4");
  }
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
  if (equirectangular) tex.mapping = THREE.EquirectangularReflectionMapping;
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

/** Создаёт общий набор статических текстур зданий и материалов городской растительности. */
export function createCityEnvironmentPack(): CityEnvironmentPack {
  const loader = new THREE.TextureLoader();
  const facadeTexture = loader.load(facadeTextureUrl);
  facadeTexture.colorSpace = THREE.SRGBColorSpace;
  facadeTexture.anisotropy = 4;
  const roofTexture = loader.load(roofTextureUrl);
  roofTexture.colorSpace = THREE.SRGBColorSpace;
  roofTexture.anisotropy = 4;

  return {
    facadeMat: new THREE.MeshStandardMaterial({
      map: facadeTexture,
      color: 0xffffff,
      roughness: 0.86,
    }),
    roofMat: new THREE.MeshStandardMaterial({
      map: roofTexture,
      color: 0xffffff,
      roughness: 0.94,
    }),
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

/** Строит здание одним коробочным мешем с общей фасадной текстурой и отдельной текстурой крыши. */
export function buildTexturedBuilding(obs: ObstacleBox, env: CityEnvironmentPack): THREE.Mesh {
  const width = Math.max(2, obs.halfX * 2);
  const depth = Math.max(2, obs.halfZ * 2);
  const height = Math.max(3.2, obs.height);
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const materials: THREE.Material[] = [
    env.facadeMat,
    env.facadeMat,
    env.roofMat,
    env.roofMat,
    env.facadeMat,
    env.facadeMat,
  ];
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.position.set(obs.cx, height * 0.5, obs.cz);
  mesh.rotation.y = obs.h;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.obstacleId = obs.id;
  return mesh;
}

/**
 * Строит здания по исходным контурам OSM, объединяя геометрию в ячейки 96×96 м.
 * Collision OBB остаются отдельными объектами ядра; здесь используются footprint/holes.
 * Shape/ExtrudeGeometry сохраняют вогнутые контуры и внутренние дворы. Некорректный полигон
 * пропускается и остаётся доступен старому OBB-рендеру как безопасный fallback.
 */
export type OsmBuildingFootprintBatchResult = {
  renderedIds: Set<string>;
  meshes: THREE.Mesh[];
};

/** Результат содержит meshes по ячейкам: SceneController может отсекать дальние батчи целиком. */
export function buildOsmBuildingFootprintBatches(
  group: THREE.Group,
  buildings: readonly ObstacleBox[],
  env: CityEnvironmentPack
): OsmBuildingFootprintBatchResult {
  const cellSize = 96;
  const cells = new Map<string, THREE.BufferGeometry[]>();
  const cellBuildingCounts = new Map<string, number>();
  const renderedIds = new Set<string>();
  const meshes: THREE.Mesh[] = [];
  const facade = env.facadeMat;
  const roof = env.roofMat;

  for (const building of buildings) {
    const outer = building.footprint;
    if (!outer || outer.length < 3) continue;
    const ring = outer.length > 3 &&
      Math.hypot(outer[0].x - outer[outer.length - 1].x, outer[0].z - outer[outer.length - 1].z) < 0.05
      ? outer.slice(0, -1)
      : outer;
    if (ring.length < 3 || ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) continue;

    const shape = new THREE.Shape();
    shape.moveTo(ring[0].x, -ring[0].z);
    for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i].x, -ring[i].z);
    shape.closePath();

    for (const hole of building.footprintHoles ?? []) {
      if (hole.length < 3 || hole.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) continue;
      const points = hole.length > 3 &&
        Math.hypot(hole[0].x - hole[hole.length - 1].x, hole[0].z - hole[hole.length - 1].z) < 0.05
        ? hole.slice(0, -1)
        : hole;
      if (points.length < 3) continue;
      const path = new THREE.Path();
      path.moveTo(points[0].x, -points[0].z);
      for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, -points[i].z);
      path.closePath();
      shape.holes.push(path);
    }

    const height = Math.max(3.2, building.height);
    let geometry: THREE.ExtrudeGeometry;
    try {
      geometry = new THREE.ExtrudeGeometry(shape, {
        depth: height,
        bevelEnabled: false,
        curveSegments: 1,
        steps: 1,
      });
    } catch {
      continue;
    }
    geometry.rotateX(-Math.PI / 2);
    const centerX = (Math.floor(building.cx / cellSize) + 0.5) * cellSize;
    const centerZ = (Math.floor(building.cz / cellSize) + 0.5) * cellSize;
    geometry.translate(-centerX, 0, -centerZ);
    const key = `${Math.floor(building.cx / cellSize)},${Math.floor(building.cz / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(geometry);
    cells.set(key, bucket);
    cellBuildingCounts.set(key, (cellBuildingCounts.get(key) ?? 0) + 1);
    renderedIds.add(building.id);
  }

  for (const [key, geometries] of cells) {
    const [gx, gz] = key.split(",").map(Number);
    const centerX = (gx + 0.5) * cellSize;
    const centerZ = (gz + 0.5) * cellSize;
    const merged = mergeGeometries(geometries, true);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, [facade, roof]);
    mesh.position.set(centerX, 0, centerZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.name = `osm-building-footprints-${key}`;
    // Положение меша — центр spatial cell; количество зданий нужно для точной метрики видимости.
    mesh.userData.buildingCount = cellBuildingCounts.get(key) ?? 0;
    group.add(mesh);
    meshes.push(mesh);
  }
  return { renderedIds, meshes };
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
      const crownKey = isSpruce ? "spruce" : `leaf:${foliageIndex}`;
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
        const yaw = rand() * Math.PI * 2;
        const h = tree.height * (0.94 + rand() * 0.22);
        const isBirch = tree.seed % 9 === 1 || tree.seed % 9 === 2;
        const trunkH = h * (isBirch ? 0.54 : 0.45);
        const radius = isBirch ? 0.14 : 0.2;
        dummy.position.set(tree.x - centerX, trunkH * 0.5, tree.z - centerZ);
        dummy.rotation.set(0, yaw, 0);
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
        const yaw = rand() * Math.PI * 2;
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
        dummy.rotation.set(0, yaw, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  // Геометрии разделяются между ячейками и освобождаются при очистке worldGroup.
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
