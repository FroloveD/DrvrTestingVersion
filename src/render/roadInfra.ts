/**
 * @module render/roadInfra
 * @layer three-render
 * @role Процедурные 3D-дороги, тротуары, бордюры БР 100.30.15, разметка, переходы 1.14.1, светофоры Т.1/П.1 с консолью, знаки и уличная инфраструктура РФ/СНГ по ГОСТ.
 * @invariants #1 (координаты +Z вперёд, +X влево), #8 (100 % офлайн), #13 (статичность на холостом старте для зеркал).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { roadGeometryPoints } from "../maps/route";
import type { CrosswalkDef, ObstacleBox, RoadSignDef, TrafficSignalDef, WorldData } from "../sim/types";
import {
  getSignBackplateForm,
  makeCrosswalkSignTexture,
  makeGostSpeedLimitTexture,
  makeRoadSignTexture,
  makeStopPlaqueTexture,
  type SignBackplateForm,
} from "./roadSignTextures";
import {
  makeGostArrow118Texture,
  makeGostAsphaltMaps,
  makeGostCurbTexture,
  makeLaneWearTexture,
  makeManholeTexture,
  makeSidewalkPaverMaps,
  makeSignalHaloTexture,
  makeStormGrateTexture,
  makeTactilePavingTexture,
  makeThermoplasticTexture,
  makeWorldUvCircle,
  makeWorldUvPlane,
} from "./roadTextures";

export type GostSignalVisualHandle = {
  def: TrafficSignalDef;
  redMat: THREE.MeshBasicMaterial;
  yellowMat: THREE.MeshBasicMaterial;
  greenMat: THREE.MeshBasicMaterial;
  redHaloMat: THREE.MeshBasicMaterial;
  yellowHaloMat: THREE.MeshBasicMaterial;
  greenHaloMat: THREE.MeshBasicMaterial;
  pedRedMat: THREE.MeshBasicMaterial;
  pedGreenMat: THREE.MeshBasicMaterial;
};

export type RoadMaterialPack = {
  asphaltMat: THREE.MeshStandardMaterial;
  laneWearMat: THREE.MeshBasicMaterial;
  sidewalkMat: THREE.MeshStandardMaterial;
  curbBwMat: THREE.MeshStandardMaterial;
  curbGreyMat: THREE.MeshStandardMaterial;
  tactileMat: THREE.MeshStandardMaterial;
  whiteMarkMat: THREE.MeshBasicMaterial;
  yellowMarkMat: THREE.MeshBasicMaterial;
  arrowMat: THREE.MeshBasicMaterial;
  manholeMat: THREE.MeshBasicMaterial;
  grateMat: THREE.MeshBasicMaterial;
  galvPoleMat: THREE.MeshStandardMaterial;
  darkIronMat: THREE.MeshStandardMaterial;
  concreteBaseMat: THREE.MeshStandardMaterial;
  signBackMat: THREE.MeshStandardMaterial;
  signalBodyMat: THREE.MeshStandardMaterial;
  signalBorderMat: THREE.MeshBasicMaterial;
  stopPlaqueMat: THREE.MeshBasicMaterial;
  cw519RightMat: THREE.MeshBasicMaterial;
  cw519LeftMat: THREE.MeshBasicMaterial;
  luminaireGlowMat: THREE.MeshBasicMaterial;
  reflRedMat: THREE.MeshBasicMaterial;
  reflWhiteMat: THREE.MeshBasicMaterial;
  reflYellowMat: THREE.MeshBasicMaterial;
  haloTex: THREE.CanvasTexture;
};

/** Создаёт общий пул ГОСТ-материалов и текстур на один вызов `loadWorld`. */
export function createRoadMaterialPack(): RoadMaterialPack {
  const asphalt = makeGostAsphaltMaps();
  const paver = makeSidewalkPaverMaps();
  const haloTex = makeSignalHaloTexture();

  return {
    asphaltMat: new THREE.MeshStandardMaterial({
      map: asphalt.map,
      bumpMap: asphalt.bumpMap,
      bumpScale: 0.016,
      roughness: 0.9,
      metalness: 0.03,
    }),
    laneWearMat: new THREE.MeshBasicMaterial({
      map: makeLaneWearTexture(),
      transparent: true,
      depthWrite: false,
    }),
    sidewalkMat: new THREE.MeshStandardMaterial({
      map: paver.map,
      bumpMap: paver.bumpMap,
      bumpScale: 0.014,
      roughness: 0.88,
    }),
    curbBwMat: new THREE.MeshStandardMaterial({ map: makeGostCurbTexture(true), roughness: 0.78 }),
    curbGreyMat: new THREE.MeshStandardMaterial({ map: makeGostCurbTexture(false), roughness: 0.84 }),
    tactileMat: new THREE.MeshStandardMaterial({ map: makeTactilePavingTexture(), roughness: 0.72 }),
    whiteMarkMat: new THREE.MeshBasicMaterial({ map: makeThermoplasticTexture(false) }),
    yellowMarkMat: new THREE.MeshBasicMaterial({ map: makeThermoplasticTexture(true) }),
    arrowMat: new THREE.MeshBasicMaterial({
      map: makeGostArrow118Texture(),
      transparent: true,
      depthWrite: false,
    }),
    manholeMat: new THREE.MeshBasicMaterial({
      map: makeManholeTexture(),
      transparent: true,
      depthWrite: false,
    }),
    grateMat: new THREE.MeshBasicMaterial({ map: makeStormGrateTexture() }),
    galvPoleMat: new THREE.MeshStandardMaterial({ color: 0x9aa6b4, metalness: 0.52, roughness: 0.42 }),
    darkIronMat: new THREE.MeshStandardMaterial({ color: 0x2b333d, metalness: 0.45, roughness: 0.52 }),
    concreteBaseMat: new THREE.MeshStandardMaterial({ color: 0x7d8690, roughness: 0.9 }),
    signBackMat: new THREE.MeshStandardMaterial({ color: 0x7c8896, metalness: 0.45, roughness: 0.48 }),
    signalBodyMat: new THREE.MeshStandardMaterial({ color: 0x151b23, roughness: 0.55, metalness: 0.2 }),
    signalBorderMat: new THREE.MeshBasicMaterial({ color: 0xf1f5f9 }),
    stopPlaqueMat: new THREE.MeshBasicMaterial({ map: makeStopPlaqueTexture(), transparent: true }),
    cw519RightMat: new THREE.MeshBasicMaterial({ map: makeCrosswalkSignTexture(false), transparent: true }),
    cw519LeftMat: new THREE.MeshBasicMaterial({ map: makeCrosswalkSignTexture(true), transparent: true }),
    luminaireGlowMat: new THREE.MeshBasicMaterial({ color: 0xfef3c7 }),
    reflRedMat: new THREE.MeshBasicMaterial({ color: 0xef4444 }),
    reflWhiteMat: new THREE.MeshBasicMaterial({ color: 0xf8fafc }),
    reflYellowMat: new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
    haloTex,
  };
}

/** Создаёт BoxGeometry бордюра с повторяющимся шагом текстуры вдоль длины `len` (1 повтор = 2 м: 1 м белый + 1 м чёрный). */
function makeCurbBoxGeo(thick: number, height: number, len: number, alongX = false): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(alongX ? len : thick, height, alongX ? thick : len);
  const uv = geo.attributes.uv;
  const rep = Math.max(0.5, len / 2.0);
  if (uv) {
    // В BoxGeometry грани: 0,1 (+X,-X: u по Z), 2,3 (+Y,-Y: u по X, v по Z), 4,5 (+Z,-Z: u по X)
    for (let face = 0; face < 6; face++) {
      const base = face * 4;
      const stretchU = alongX ? face >= 2 : face <= 1;
      const stretchV = !alongX && (face === 2 || face === 3);
      for (let k = 0; k < 4; k++) {
        const idx = base + k;
        const u = uv.getX(idx);
        const v = uv.getY(idx);
        if (stretchV) {
          // Поворачиваем UV верхней грани на 90°, чтобы чередование камней совпадало с боковой гранью
          uv.setXY(idx, v * rep, u);
        } else if (stretchU) {
          uv.setXY(idx, u * rep, v);
        }
      }
    }
    uv.needsUpdate = true;
  }
  return geo;
}

/** Разбивает отрезок `[dStart, dEnd]` на непрерывные интервалы, где `isBlocked(d)` возвращает `false`. */
function collectClearSpans(
  dStart: number,
  dEnd: number,
  stepM: number,
  minRunM: number,
  isBlocked: (d: number) => boolean
): Array<[number, number]> {
  const span = dEnd - dStart;
  if (span < minRunM) return [];
  const samples = Math.max(2, Math.min(96, Math.ceil(span / stepM)));
  const out: Array<[number, number]> = [];
  let run0: number | null = null;
  for (let s = 0; s <= samples; s++) {
    const d = dStart + (span * s) / samples;
    const blocked = isBlocked(d);
    if (!blocked && run0 === null) {
      run0 = d;
    } else if (blocked && run0 !== null) {
      if (d - run0 >= minRunM) out.push([run0, d]);
      run0 = null;
    }
  }
  if (run0 !== null && dEnd - run0 >= minRunM) out.push([run0, dEnd]);
  return out;
}

/** Строит полотно дорог, следы наката, объёмные тротуары с плиткой, ГОСТ-бордюры, мосты 11ДО, люки и разметку ГОСТ Р 51256. */
export function buildWorldRoadsAndSidewalks(
  group: THREE.Group,
  world: WorldData,
  mats: RoadMaterialPack
): void {
  const isStreet = (roadId: string) =>
    world.scenarioId === "city_osm" || (world.scenarioId === "custom" && roadId !== "custom-lot");

  const roadPointsById = new Map(
    world.roads.map((road) => [road.id, roadGeometryPoints(road.points, road.cornerRadiusM ?? 0)] as const)
  );
  const surfaceStreets = world.roads.filter((r) => isStreet(r.id) && (r.layer ?? 0) === 0);

  // Пространственный индекс сегментов для проверки перекрёстков. Длинные OSM-сегменты
  // дробятся только для индексации: объединение частей геометрически совпадает с исходным сегментом.
  const junctionCellSize = 32;
  const junctionMaxPad = 4;
  type JunctionSegment = {
    roadId: string;
    ax: number;
    az: number;
    bx: number;
    bz: number;
    halfWidth: number;
  };
  const junctionSegmentsByCell = new Map<string, JunctionSegment[]>();
  const junctionCellKey = (x: number, z: number) => `${x},${z}`;
  const addJunctionSegment = (segment: JunctionSegment) => {
    const margin = segment.halfWidth + junctionMaxPad;
    const minCellX = Math.floor((Math.min(segment.ax, segment.bx) - margin) / junctionCellSize);
    const maxCellX = Math.floor((Math.max(segment.ax, segment.bx) + margin) / junctionCellSize);
    const minCellZ = Math.floor((Math.min(segment.az, segment.bz) - margin) / junctionCellSize);
    const maxCellZ = Math.floor((Math.max(segment.az, segment.bz) + margin) / junctionCellSize);
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cz = minCellZ; cz <= maxCellZ; cz++) {
        const key = junctionCellKey(cx, cz);
        const bucket = junctionSegmentsByCell.get(key);
        if (bucket) bucket.push(segment);
        else junctionSegmentsByCell.set(key, [segment]);
      }
    }
  };

  for (const road of surfaceStreets) {
    const points = roadPointsById.get(road.id) ?? road.points;
    const halfWidth = road.width * 0.5;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      const pieces = Math.max(1, Math.ceil(length / junctionCellSize));
      for (let part = 0; part < pieces; part++) {
        const t0 = part / pieces;
        const t1 = (part + 1) / pieces;
        addJunctionSegment({
          roadId: road.id,
          ax: a.x + dx * t0,
          az: a.z + dz * t0,
          bx: a.x + dx * t1,
          bz: a.z + dz * t1,
          halfWidth,
        });
      }
    }
  }

  const inJunction = (px: number, pz: number, ownId: string, pad = 1.5): boolean => {
    const cellX = Math.floor(px / junctionCellSize);
    const cellZ = Math.floor(pz / junctionCellSize);
    const candidates = junctionSegmentsByCell.get(junctionCellKey(cellX, cellZ));
    if (!candidates) return false;
    for (const segment of candidates) {
      if (segment.roadId === ownId) continue;
      const abx = segment.bx - segment.ax;
      const abz = segment.bz - segment.az;
      const lenSq = abx * abx + abz * abz;
      const t = lenSq > 1e-6
        ? Math.max(0, Math.min(1, ((px - segment.ax) * abx + (pz - segment.az) * abz) / lenSq))
        : 0;
      const cx = segment.ax + abx * t;
      const cz = segment.az + abz * t;
      const limit = segment.halfWidth + pad;
      if ((px - cx) * (px - cx) + (pz - cz) * (pz - cz) <= limit * limit) return true;
    }
    return false;
  };

  const inCrosswalk = (px: number, pz: number, pad = 0.9): boolean => {
    for (const cw of world.crosswalks) {
      const dx = px - cw.cx;
      const dz = pz - cw.cz;
      const along = Math.abs(dx * Math.sin(cw.h) + dz * Math.cos(cw.h));
      const across = Math.abs(dx * Math.cos(cw.h) - dz * Math.sin(cw.h));
      if (along <= Math.max(cw.length * 0.5, 1.8) + pad && across <= cw.width * 0.5 + pad + 2.4) return true;
    }
    return false;
  };

  const inBayOpening = (px: number, pz: number): boolean => {
    for (const bay of world.bays) {
      const dx = px - bay.cx;
      const dz = pz - bay.cz;
      const along = Math.abs(dx * Math.sin(bay.h) + dz * Math.cos(bay.h));
      const across = Math.abs(dx * Math.cos(bay.h) - dz * Math.sin(bay.h));
      if (along <= bay.length * 0.5 + 1.8 && across <= bay.width * 0.5 + 2.2) return true;
    }
    return false;
  };

  const nearControlZone = (px: number, pz: number): boolean => {
    for (const sig of world.signals) {
      if ((px - sig.stopLineX) ** 2 + (pz - sig.stopLineZ) ** 2 <= 18 * 18) return true;
    }
    for (const cw of world.crosswalks) {
      if ((px - cw.cx) ** 2 + (pz - cw.cz) ** 2 <= 15 * 15) return true;
    }
    return false;
  };

  // Непрозрачные плоские элементы дороги объединяются по материалу и ячейкам 192×192 м.
  // Геометрия/UV остаются прежними; трансформы запекаются в вершины, поэтому меняется только число draw calls.
  const flatBatchCellSize = 192;
  type FlatMeshBatch = {
    material: THREE.Material;
    receiveShadow: boolean;
    centerX: number;
    centerZ: number;
    geometries: THREE.BufferGeometry[];
  };
  const flatMeshBatches = new Map<string, FlatMeshBatch>();
  const flatTransform = new THREE.Object3D();

  // Бордюры — повторяющиеся BoxGeometry с одинаковыми материалами.
  // Храним матрицы экземпляров по материалу и той же spatial-сетке 192×192 м.
  type CurbInstanceBatch = {
    material: THREE.Material;
    centerX: number;
    centerZ: number;
    matrices: THREE.Matrix4[];
  };
  const curbInstanceBatches = new Map<string, CurbInstanceBatch>();
  const curbTransform = new THREE.Object3D();

  const addCurbInstance = (
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    angle: number,
    width: number,
    height: number,
    length: number
  ) => {
    const cellX = Math.floor(x / flatBatchCellSize);
    const cellZ = Math.floor(z / flatBatchCellSize);
    const centerX = (cellX + 0.5) * flatBatchCellSize;
    const centerZ = (cellZ + 0.5) * flatBatchCellSize;
    const key = `${material.uuid}|${cellX},${cellZ}`;
    let batch = curbInstanceBatches.get(key);
    if (!batch) {
      batch = { material, centerX, centerZ, matrices: [] };
      curbInstanceBatches.set(key, batch);
    }
    curbTransform.position.set(x - centerX, y, z - centerZ);
    curbTransform.rotation.set(0, angle, 0);
    curbTransform.scale.set(width, height, length);
    curbTransform.updateMatrix();
    batch.matrices.push(curbTransform.matrix.clone());
  };

  const addFlatMesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    angle: number,
    recvShadow = false
  ) => {
    // Прочие прозрачные decals оставляем отдельными из-за сортировки по глубине.
    // Следы наката OSM-карт лежат на дорожной плоскости и объединяются по ячейкам:
    // у них один материал и нет взаимного перекрытия с разными уровнями прозрачности.
    const batchLaneWear = world.scenarioId === "city_osm" && mat === mats.laneWearMat;
    if ((mat.transparent && !batchLaneWear) || geo.groups.length > 0) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.order = "YXZ";
      mesh.rotation.y = angle;
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, y, z);
      if (recvShadow) mesh.receiveShadow = true;
      group.add(mesh);
      return;
    }

    const cellX = Math.floor(x / flatBatchCellSize);
    const cellZ = Math.floor(z / flatBatchCellSize);
    const centerX = (cellX + 0.5) * flatBatchCellSize;
    const centerZ = (cellZ + 0.5) * flatBatchCellSize;
    const attributeLayout = Object.entries(geo.attributes)
      .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`)
      .sort()
      .join("|");
    const key = `${mat.uuid}|${recvShadow ? 1 : 0}|${cellX},${cellZ}|${attributeLayout}`;
    let batch = flatMeshBatches.get(key);
    if (!batch) {
      batch = { material: mat, receiveShadow: recvShadow, centerX, centerZ, geometries: [] };
      flatMeshBatches.set(key, batch);
    }

    flatTransform.position.set(x - centerX, y, z - centerZ);
    flatTransform.rotation.order = "YXZ";
    flatTransform.rotation.y = angle;
    flatTransform.rotation.x = -Math.PI / 2;
    flatTransform.scale.set(1, 1, 1);
    flatTransform.updateMatrix();
    batch.geometries.push(geo.clone().applyMatrix4(flatTransform.matrix));
  };

  let segSerial = 0;
  for (const road of world.roads) {
    const street = isStreet(road.id);
    const layerVal = road.layer ?? 0;
    const isBridge = street && layerVal > 0;
    const layerLift = isBridge ? Math.min(0.24, layerVal * 0.08) : 0;
    const isMinorService = road.highway === "service" || road.highway === "living_street";

    const roadPoints = roadPointsById.get(road.id) ?? road.points;

    // Круглые стыки асфальта и тротуарной плитки в вершинах улиц (мировые UV, 0 z-fighting)
    if (street && roadPoints.length >= 2) {
      const asphCapGeo = makeWorldUvCircle(road.width * 0.5, 18, 4.5);
      const swCapGeo = !isBridge ? makeWorldUvCircle(road.width * 0.5 + 2.15, 16, 2.4) : null;
      for (const vp of roadPoints) {
        if (swCapGeo) {
          addFlatMesh(swCapGeo, mats.sidewalkMat, vp.x, 0.005 + layerLift, vp.z, 0, true);
        }
        addFlatMesh(asphCapGeo, mats.asphaltMat, vp.x, 0.0118 + layerLift, vp.z, 0, true);
      }
    }

    for (let i = 0; i < roadPoints.length - 1; i++) {
      const p0 = roadPoints[i];
      const p1 = roadPoints[i + 1];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;

      const angle = Math.atan2(dx, dz);
      const fx = dx / len;
      const fz = dz / len;
      // Левая нормаль (+X в локальной системе дороги)
      const lx = fz;
      const lz = -fx;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;
      const microY = street ? (segSerial++ % 13) * 0.0001 : 0;

      // 1. Основное полотно асфальтобетона ЩМА (мировой масштаб тайла 4.5 м)
      const asphY = 0.012 + layerLift + microY;
      addFlatMesh(makeWorldUvPlane(road.width, len, 4.5), mats.asphaltMat, mx, asphY, mz, angle, true);

      // Для учебной площадки автодрома — аккуратная краевая разметка 1.2 и бетонная отбортовка периметра
      if (!street) {
        const rimPad = 0.14;
        for (const side of [-1, 1]) {
          addFlatMesh(
            new THREE.PlaneGeometry(0.12, Math.max(0.5, len - 0.5)),
            mats.whiteMarkMat,
            mx + lx * side * (road.width * 0.5 - 0.22),
            0.018,
            mz + lz * side * (road.width * 0.5 - 0.22),
            angle
          );
          const rim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, len + 0.3), mats.concreteBaseMat);
          rim.rotation.y = angle;
          rim.position.set(
            mx + lx * side * (road.width * 0.5 + rimPad),
            0.03,
            mz + lz * side * (road.width * 0.5 + rimPad)
          );
          rim.receiveShadow = true;
          group.add(rim);
        }
        for (const endSign of [-1, 1]) {
          const ex = mx + fx * endSign * (len * 0.5 + rimPad);
          const ez = mz + fz * endSign * (len * 0.5 + rimPad);
          const rimEnd = new THREE.Mesh(new THREE.BoxGeometry(road.width + 0.5, 0.06, 0.22), mats.concreteBaseMat);
          rimEnd.rotation.y = angle;
          rimEnd.position.set(ex, 0.03, ez);
          rimEnd.receiveShadow = true;
          group.add(rimEnd);
        }
        // Мягкий след наката по центральному проезду автодрома
        if (len >= 12) {
          addFlatMesh(makeWorldUvPlane(3.4, len - 1.5, 3.4, 6), mats.laneWearMat, mx, 0.015, mz, angle);
        }
        continue;
      }

      // 2. Тротуарная подложка + объёмные приподнятые тротуары и бордюр БР 100.30.15 по обеим сторонам улицы
      if (!isBridge && !isMinorService) {
        addFlatMesh(makeWorldUvPlane(road.width + 4.3, len, 2.4), mats.sidewalkMat, mx, 0.005 + microY, mz, angle, true);

        const swW = 1.95;
        const swH = 0.095;
        const curbW = 0.17;
        const curbH = 0.118;
        for (const side of [-1, 1]) {
          const curbOff = side * (road.width * 0.5 + curbW * 0.5 + 0.04);
          const swOff = side * (road.width * 0.5 + curbW + swW * 0.5 + 0.04);
          const spans = collectClearSpans(0.6, len - 0.6, 2.2, 2.6, (d) => {
            const sx = p0.x + fx * d + lx * curbOff;
            const sz = p0.z + fz * d + lz * curbOff;
            return (
              (layerVal === 0 && inJunction(sx, sz, road.id, 2.3)) ||
              inCrosswalk(sx, sz, 1.1) ||
              inBayOpening(sx, sz)
            );
          });
          for (const [d0, d1] of spans) {
            const rLen = d1 - d0;
            const dMid = (d0 + d1) * 0.5;
            const bx = p0.x + fx * dMid;
            const bz = p0.z + fz * dMid;

            // Верхняя грань приподнятого тротуара с плиткой + садовый поребрик БР 100.20.8 по внешней кромке
            addFlatMesh(
              makeWorldUvPlane(swW, rLen, 2.4),
              mats.sidewalkMat,
              bx + lx * swOff,
              swH + microY,
              bz + lz * swOff,
              angle,
              true
            );
            const backOff = swOff + side * (swW * 0.5 + 0.045);
            const backRim = new THREE.Mesh(new THREE.BoxGeometry(0.09, swH, rLen), mats.concreteBaseMat);
            backRim.rotation.y = angle;
            backRim.position.set(bx + lx * backOff, swH * 0.5, bz + lz * backOff);
            group.add(backRim);

            // Бордюр БР 100.30.15: у перекрёстков и переходов — чёрно-белый ГОСТ, в середине квартала — бетонный
            const useBw = nearControlZone(bx, bz);
            addCurbInstance(
              useBw ? mats.curbBwMat : mats.curbGreyMat,
              bx + lx * curbOff,
              curbH * 0.5,
              bz + lz * curbOff,
              angle,
              curbW,
              curbH,
              rLen
            );
          }
        }
      } else if (isBridge) {
        // 2б. Пролётное строение эстакады + металлическое барьерное ограждение 11ДО с катафотами КД-3
        const deck = new THREE.Mesh(
          new THREE.BoxGeometry(road.width + 0.9, 0.14, len),
          mats.concreteBaseMat
        );
        deck.rotation.y = angle;
        deck.position.set(mx, asphY - 0.075, mz);
        group.add(deck);

        for (const side of [-1, 1]) {
          const gOff = side * (road.width * 0.5 + 0.24);
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, len), mats.galvPoleMat);
          beam.rotation.y = angle;
          beam.position.set(mx + lx * gOff, asphY + 0.56, mz + lz * gOff);
          beam.castShadow = true;
          group.add(beam);

          const postCount = Math.min(28, Math.max(2, Math.floor(len / 4) + 1));
          for (let pk = 0; pk < postCount; pk++) {
            const pd = postCount === 1 ? len * 0.5 : (pk / (postCount - 1)) * len;
            const px = p0.x + fx * pd + lx * gOff;
            const pz = p0.z + fz * pd + lz * gOff;
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.72, 0.1), mats.galvPoleMat);
            post.rotation.y = angle;
            post.position.set(px, asphY + 0.36, pz);
            group.add(post);

            // Катафот КД-3: справа по ходу красный, слева белый (ГОСТ Р 52289)
            if (pk % 2 === 0) {
              const refl = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, 0.1, 0.14),
                side < 0 ? mats.reflRedMat : mats.reflWhiteMat
              );
              refl.rotation.y = angle;
              refl.position.set(px - lx * side * 0.06, asphY + 0.58, pz - lz * side * 0.06);
              group.add(refl);
            }
          }
        }
      }

      // 3. Следы наката колёс по каждой полосе + чугунные люки ГОСТ 3634 и дождеприёмники
      const laneCount = Math.max(1, Math.min(6, Math.round(road.lanes || 2)));
      const laneW = (road.width - 0.5) / laneCount;
      if (len >= 12 && !isMinorService) {
        const wearSpans = collectClearSpans(2, len - 2, 3, 6, (d) =>
          layerVal === 0 && inJunction(p0.x + fx * d, p0.z + fz * d, road.id, 1.2)
        );
        for (const [d0, d1] of wearSpans) {
          const rLen = d1 - d0;
          const dMid = (d0 + d1) * 0.5;
          const bx = p0.x + fx * dMid;
          const bz = p0.z + fz * dMid;
          for (let li = 0; li < laneCount; li++) {
            const laneOff = ((li + 0.5) / laneCount - 0.5) * (road.width - 0.5);
            addFlatMesh(
              makeWorldUvPlane(Math.min(3.1, laneW * 0.86), rLen, Math.min(3.1, laneW * 0.86), 8),
              mats.laneWearMat,
              bx + lx * laneOff,
              asphY + 0.0032,
              bz + lz * laneOff,
              angle
            );
          }
        }
      }

      // Люки и ливнёвые решётки (только на наземных улицах, вне перекрёстков и переходов)
      if (!isBridge && !isMinorService && len >= 34) {
        const mhStep = 42;
        for (let d = 18; d < len - 14; d += mhStep) {
          const cx = p0.x + fx * d;
          const cz = p0.z + fz * d;
          if (inJunction(cx, cz, road.id, 4) || inCrosswalk(cx, cz, 3) || inBayOpening(cx, cz)) continue;
          const mhOff = -laneW * 0.35;
          addFlatMesh(
            new THREE.PlaneGeometry(0.76, 0.76),
            mats.manholeMat,
            cx + lx * mhOff,
            asphY + 0.0055,
            cz + lz * mhOff,
            angle
          );
          // Прилотковая ливнёвая решётка у правого бордюра
          const gOff = -(road.width * 0.5 - 0.28);
          addFlatMesh(
            new THREE.PlaneGeometry(0.42, 0.82),
            mats.grateMat,
            cx + fx * 6 + lx * gOff,
            asphY + 0.0055,
            cz + fz * 6 + lz * gOff,
            angle
          );
        }
      }

      // 4. Горизонтальная дорожная разметка ГОСТ Р 51256-2018
      const markY = 0.022 + layerLift + microY;
      const isMarkBlocked = (d: number) => {
        const px = p0.x + fx * d;
        const pz = p0.z + fz * d;
        return (layerVal === 0 && inJunction(px, pz, road.id, 1.45)) || inCrosswalk(px, pz, 0.7);
      };

      // 4а. Краевая сплошная линия 1.2 по обеим кромкам проезжей части (для городских и магистральных улиц)
      if (!isMinorService && road.width >= 6.8 && len > 10) {
        const edgeInset = road.width * 0.5 - 0.28;
        for (const side of [-1, 1]) {
          const eSpans = collectClearSpans(1.8, len - 1.8, 2.6, 3.0, (d) => {
            const ex = p0.x + fx * d + lx * side * edgeInset;
            const ez = p0.z + fz * d + lz * side * edgeInset;
            return (
              (layerVal === 0 && inJunction(ex, ez, road.id, 1.9)) ||
              inCrosswalk(ex, ez, 0.7) ||
              inBayOpening(ex, ez)
            );
          });
          for (const [d0, d1] of eSpans) {
            const dMid = (d0 + d1) * 0.5;
            addFlatMesh(
              new THREE.PlaneGeometry(0.12, d1 - d0),
              mats.whiteMarkMat,
              p0.x + fx * dMid + lx * side * edgeInset,
              markY,
              p0.z + fz * dMid + lz * side * edgeInset,
              angle
            );
          }
        }
      }

      // 4б. Осевая (1.1 одинарная / 1.3 двойная сплошная / 1.5 прерывистая) и межполосная (1.5 / 1.6) разметка
      if (laneCount >= 2 && len > 8) {
        const endPad = Math.min(3.6, len * 0.18);
        const emitDashedLine = (latOffset: number) => {
          const dashCount = Math.floor(len / 5.5);
          for (let k = 0; k < dashCount; k++) {
            const d = ((k + 0.5) / dashCount) * len;
            if (isMarkBlocked(d)) continue;
            const px = p0.x + fx * d + lx * latOffset;
            const pz = p0.z + fz * d + lz * latOffset;
            // Линия приближения 1.6 (удлинённый штрих) вблизи стоп-линий и переходов
            const dashLen = nearControlZone(px, pz) ? 3.4 : 2.1;
            addFlatMesh(new THREE.PlaneGeometry(0.13, dashLen), mats.whiteMarkMat, px, markY, pz, angle);
          }
        };

        if (road.oneway) {
          // На односторонней улице все полосы попутные — разделяем их прерывистой 1.5
          for (let div = 1; div < laneCount; div++) {
            const off = (div / laneCount - 0.5) * (road.width - 0.5);
            emitDashedLine(off);
          }
        } else {
          const isDoubleSolid = laneCount >= 4 || (road.hasSolidCenter && road.width >= 12.5);
          if (isDoubleSolid || road.hasSolidCenter) {
            const cSpans = collectClearSpans(endPad, len - endPad, 2.5, 2.2, isMarkBlocked);
            for (const [d0, d1] of cSpans) {
              const rLen = d1 - d0;
              const dMid = (d0 + d1) * 0.5;
              const cx = p0.x + fx * dMid;
              const cz = p0.z + fz * dMid;
              if (isDoubleSolid) {
                // Разметка 1.3 — двойная сплошная (две линии по 0.12 м с зазором 0.14 м)
                for (const s of [-0.13, 0.13]) {
                  addFlatMesh(
                    new THREE.PlaneGeometry(0.12, rLen),
                    mats.whiteMarkMat,
                    cx + lx * s,
                    markY,
                    cz + lz * s,
                    angle
                  );
                }
              } else {
                addFlatMesh(new THREE.PlaneGeometry(0.14, rLen), mats.whiteMarkMat, cx, markY, cz, angle);
              }
            }
          } else {
            emitDashedLine(0);
          }

          // Межполосная прерывистая 1.5 для 4+ полосных проспектов
          if (laneCount >= 4) {
            const halfLanes = Math.floor(laneCount / 2);
            for (let sub = 1; sub < halfLanes; sub++) {
              const off = (sub / laneCount) * (road.width - 0.5);
              emitDashedLine(off);
              emitDashedLine(-off);
            }
          }
        }
      }

      // 4в. Вытянутые ГОСТ-стрелы направления 1.18 на односторонних улицах (по центру каждой полосы)
      if (road.oneway && len >= 16) {
        const arrowCount = Math.min(8, Math.max(1, Math.floor(len / 28)));
        for (let aIdx = 0; aIdx < arrowCount; aIdx++) {
          const d = ((aIdx + 0.5) / arrowCount) * len;
          if (isMarkBlocked(d)) continue;
          const bx = p0.x + fx * d;
          const bz = p0.z + fz * d;
          for (let li = 0; li < laneCount; li++) {
            const off = laneCount === 1 ? 0 : ((li + 0.5) / laneCount - 0.5) * (road.width - 0.6);
            addFlatMesh(
              new THREE.PlaneGeometry(0.85, 3.1),
              mats.arrowMat,
              bx + lx * off,
              markY + 0.001,
              bz + lz * off,
              angle + Math.PI
            );
          }
        }
      }
    }
  }

  for (const batch of flatMeshBatches.values()) {
    const merged = batch.geometries.length === 1
      ? batch.geometries[0]
      : mergeGeometries(batch.geometries, false);
    if (!merged) {
      // Консервативный fallback: не теряем геометрию, если конкретная пара атрибутов несовместима.
      for (const geometry of batch.geometries) {
        const mesh = new THREE.Mesh(geometry, batch.material);
        mesh.position.set(batch.centerX, 0, batch.centerZ);
        mesh.receiveShadow = batch.receiveShadow;
        group.add(mesh);
      }
      continue;
    }
    if (batch.geometries.length > 1) {
      for (const geometry of batch.geometries) geometry.dispose();
    }
    const mesh = new THREE.Mesh(merged, batch.material);
    mesh.position.set(batch.centerX, 0, batch.centerZ);
    mesh.receiveShadow = batch.receiveShadow;
    mesh.name = "road-flat-batch";
    group.add(mesh);
  }

  if (curbInstanceBatches.size > 0) {
    const curbGeometry = new THREE.BoxGeometry(1, 1, 1);
    for (const [key, batch] of curbInstanceBatches) {
      const mesh = new THREE.InstancedMesh(curbGeometry, batch.material, batch.matrices.length);
      mesh.position.set(batch.centerX, 0, batch.centerZ);
      batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = `road-curb-instances-${key.split("|").at(-1)}`;
      mesh.userData.instanceCount = batch.matrices.length;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
}

/** Создаёт фигурную металлическую подложку дорожного знака строго по форме ГОСТ (без квадратных углов сзади). */
function makeSignBackplateGeo(form: SignBackplateForm, size: number): THREE.BufferGeometry {
  const r = size * 0.47;
  switch (form) {
    case "circle":
      return new THREE.CircleGeometry(r, 24);
    case "octagon": {
      const sh = new THREE.Shape();
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) sh.moveTo(x, y);
        else sh.lineTo(x, y);
      }
      sh.closePath();
      return new THREE.ShapeGeometry(sh);
    }
    case "triangle_down": {
      const sh = new THREE.Shape();
      sh.moveTo(-r * 0.92, r * 0.74);
      sh.lineTo(r * 0.92, r * 0.74);
      sh.lineTo(0, -r * 0.92);
      sh.closePath();
      return new THREE.ShapeGeometry(sh);
    }
    case "diamond": {
      const sh = new THREE.Shape();
      const d = r * 0.94;
      sh.moveTo(0, d);
      sh.lineTo(d, 0);
      sh.lineTo(0, -d);
      sh.lineTo(-d, 0);
      sh.closePath();
      return new THREE.ShapeGeometry(sh);
    }
    case "rect_living":
      return new THREE.PlaneGeometry(size * 0.9, size * 0.82);
    case "shield_519":
      return new THREE.PlaneGeometry(size * 0.95, size * 0.95);
    case "square":
      return new THREE.PlaneGeometry(size * 0.89, size * 0.89);
  }
}

/** Собирает оцинкованную стойку ГОСТ с бетонным стаканом, заглушкой и двумя хомутами крепления. */
function addSignPoleHardware(g: THREE.Group, poleH: number, signY: number, mats: RoadMaterialPack): void {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.18, 10), mats.concreteBaseMat);
  base.position.y = 0.09;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.042, poleH, 10), mats.galvPoleMat);
  pole.position.y = poleH * 0.5;
  pole.castShadow = true;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.04, 10), mats.darkIronMat);
  cap.position.y = poleH + 0.015;
  g.add(base, pole, cap);

  for (const dy of [-0.17, 0.17]) {
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.09), mats.darkIronMat);
    clamp.position.set(0, signY + dy, -0.02);
    g.add(clamp);
  }
}

/**
 * Инстансинг типовых стоек дорожных знаков для крупных OSM-сцен.
 * Лицевые/обратные панели остаются отдельными объектами, чтобы сохранить уникальные текстуры.
 */
export function buildOsmSignSupportInstances(
  group: THREE.Group,
  signs: Array<{ x: number; z: number; h: number }>,
  mats: RoadMaterialPack
): void {
  const cellSize = 96;
  const cells = new Map<string, Array<{ x: number; z: number; h: number }>>();
  for (const sign of signs) {
    const key = `${Math.floor(sign.x / cellSize)},${Math.floor(sign.z / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(sign);
    cells.set(key, bucket);
  }

  const baseGeo = new THREE.CylinderGeometry(0.11, 0.14, 0.18, 10);
  const poleGeo = new THREE.CylinderGeometry(0.036, 0.042, 2.86, 10);
  const capGeo = new THREE.CylinderGeometry(0.044, 0.044, 0.04, 10);
  const clampGeo = new THREE.BoxGeometry(0.12, 0.045, 0.09);
  const dummy = new THREE.Object3D();

  for (const [key, bucket] of cells) {
    const [gx, gz] = key.split(",").map(Number);
    const centerX = (gx + 0.5) * cellSize;
    const centerZ = (gz + 0.5) * cellSize;
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.position.set(centerX, 0, centerZ);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    };
    const bases = make(baseGeo, mats.concreteBaseMat, bucket.length);
    const poles = make(poleGeo, mats.galvPoleMat, bucket.length);
    const caps = make(capGeo, mats.darkIronMat, bucket.length);
    const clamps = make(clampGeo, mats.darkIronMat, bucket.length * 2);

    bucket.forEach((sign, index) => {
      const x = sign.x - centerX;
      const z = sign.z - centerZ;
      const set = (mesh: THREE.InstancedMesh, slot: number, px: number, py: number, pz: number, yaw = sign.h) => {
        dummy.position.set(x + px * Math.cos(sign.h) + pz * Math.sin(sign.h), py, z - px * Math.sin(sign.h) + pz * Math.cos(sign.h));
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
      };
      set(bases, index, 0, 0.09, 0);
      set(poles, index, 0, 1.43, 0);
      set(caps, index, 0, 2.875, 0);
      set(clamps, index * 2, 0, 2.35, -0.02);
      set(clamps, index * 2 + 1, 0, 2.69, -0.02);
    });

    for (const mesh of [bases, poles, caps, clamps]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
}

/** Строит дорожный знак ГОСТ Р 52290-2004 на оцинкованной стойке с фигурной подложкой и хомутами. */
export function buildGostRoadSign(group: THREE.Group, sign: RoadSignDef, mats: RoadMaterialPack, includeHardware = true): void {
  const g = new THREE.Group();
  g.position.set(sign.x, 0, sign.z);
  g.rotation.y = sign.h;

  const size = sign.kind === "crosswalk" ? 0.84 : 0.74;
  const signY = 2.52;
  if (includeHardware) addSignPoleHardware(g, 2.86, signY, mats);

  const front = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: makeRoadSignTexture(sign), transparent: true, alphaTest: 0.08 })
  );
  // Лицевая сторона смотрит к -Z (навстречу водителю, движущемуся вдоль +Z)
  front.position.set(0, signY, -0.056);
  front.rotation.y = Math.PI;

  const back = new THREE.Mesh(makeSignBackplateGeo(getSignBackplateForm(sign.kind), size), mats.signBackMat);
  back.position.set(0, signY, -0.046);
  back.castShadow = true;

  g.add(front, back);
  group.add(g);
}

/** Строит знак 3.24 «Ограничение скорости» для встроенных `speedZones` (ориентирован к подъезжающему потоку). */
export function buildGostSpeedSign(
  group: THREE.Group,
  limitKmh: number,
  x: number,
  z: number,
  h: number,
  mats: RoadMaterialPack,
  includeHardware = true
): void {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = h;

  const size = 0.74;
  const signY = 2.52;
  if (includeHardware) addSignPoleHardware(g, 2.86, signY, mats);

  const tex = makeGostSpeedLimitTexture(limitKmh);
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.08 });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(size, size), faceMat);
  front.position.set(0, signY, -0.056);
  front.rotation.y = Math.PI;

  const back = new THREE.Mesh(new THREE.CircleGeometry(size * 0.47, 24), mats.signBackMat);
  back.position.set(0, signY, -0.046);
  back.castShadow = true;

  g.add(front, back);
  group.add(g);
}

/** Строит пешеходный переход ГОСТ 1.14.1 (бело-жёлтая «зебра»), тактильную плитку и знаки 5.19.1/5.19.2 на обеих сторонах. */
export function buildGostCrosswalk(group: THREE.Group, cw: CrosswalkDef, mats: RoadMaterialPack): void {
  const cwGroup = new THREE.Group();
  cwGroup.position.set(cw.cx, 0.026, cw.cz);
  cwGroup.rotation.y = cw.h;

  // Бело-жёлтая разметка 1.14.1 по ГОСТ Р 51256 (чередование белых и жёлтых полос термопластика)
  const usableW = Math.max(1.8, cw.width - 0.8);
  const stripes = Math.max(3, Math.floor(cw.width / 0.82));
  for (let i = 0; i < stripes; i++) {
    const sx = ((i + 0.5) / stripes - 0.5) * usableW;
    const isYellow = i % 2 === 1;
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(isYellow ? 0.36 : 0.44, cw.length),
      isYellow ? mats.yellowMarkMat : mats.whiteMarkMat
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(sx, isYellow ? -0.0005 : 0, 0);
    cwGroup.add(stripe);
  }

  // Жёлтая рифлёная тактильная плитка ГОСТ Р 52875 на обоих сходах с тротуара
  const tactLen = Math.min(2.8, cw.length * 0.78);
  for (const side of [-1, 1]) {
    const tact = new THREE.Mesh(makeWorldUvPlane(0.62, tactLen, 0.62), mats.tactileMat);
    tact.rotation.x = -Math.PI / 2;
    tact.position.set(side * (cw.width * 0.5 + 0.58), 0.078, 0);
    tact.receiveShadow = true;
    cwGroup.add(tact);
  }

  // Двусторонние знаки 5.19.1 и 5.19.2 на флуоресцентных жёлто-зелёных щитах ГОСТ справа и слева от перехода
  const addDual519Post = (px: number, pz: number, frontIs5191: boolean) => {
    const post = new THREE.Group();
    post.position.set(px, -0.026, pz);
    const signY = 2.58;
    addSignPoleHardware(post, 2.95, signY, mats);

    const core = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.82, 0.028), mats.signBackMat);
    core.position.set(0, signY, 0);
    core.castShadow = true;

    const f1 = new THREE.Mesh(
      new THREE.PlaneGeometry(0.84, 0.84),
      frontIs5191 ? mats.cw519RightMat : mats.cw519LeftMat
    );
    f1.position.set(0, signY, -0.018);
    f1.rotation.y = Math.PI;

    const f2 = new THREE.Mesh(
      new THREE.PlaneGeometry(0.84, 0.84),
      frontIs5191 ? mats.cw519LeftMat : mats.cw519RightMat
    );
    f2.position.set(0, signY, 0.018);

    post.add(core, f1, f2);
    cwGroup.add(post);
  };

  addDual519Post(-cw.width * 0.5 - 0.95, -cw.length * 0.5 - 0.55, true);
  addDual519Post(cw.width * 0.5 + 0.95, cw.length * 0.5 + 0.55, false);

  group.add(cwGroup);
}

/** Собирает трёхсекционную транспортную головку светофора Т.1 по ГОСТ (белый кант + козырьки + LED-линзы + ореол). */
function makeSignalHeadT1(
  scale: number,
  mats: RoadMaterialPack,
  redMat: THREE.MeshBasicMaterial,
  yellowMat: THREE.MeshBasicMaterial,
  greenMat: THREE.MeshBasicMaterial,
  redHaloMat: THREE.MeshBasicMaterial,
  yellowHaloMat: THREE.MeshBasicMaterial,
  greenHaloMat: THREE.MeshBasicMaterial
): THREE.Group {
  const head = new THREE.Group();
  const w = 0.36 * scale;
  const h = 1.06 * scale;
  const d = 0.22 * scale;

  // Белый световозвращающий фоновый экран (кант) по ГОСТ Р 52282
  const screen = new THREE.Mesh(new THREE.BoxGeometry(w + 0.09 * scale, h + 0.09 * scale, 0.022), mats.signalBorderMat);
  screen.position.z = -d * 0.42;
  // Чёрный корпус светофора
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.signalBodyMat);
  body.castShadow = true;
  head.add(screen, body);

  const lensR = 0.118 * scale;
  const lensGeo = new THREE.CircleGeometry(lensR, 18);
  const haloGeo = new THREE.PlaneGeometry(lensR * 3.5, lensR * 3.5);
  // Полукруглый солнцезащитный козырёк (бленда) над каждой линзой
  const visorGeo = new THREE.CylinderGeometry(
    lensR * 1.08,
    lensR * 1.08,
    0.16 * scale,
    14,
    1,
    true,
    -Math.PI * 0.55,
    Math.PI * 1.1
  );

  const items: Array<[number, THREE.MeshBasicMaterial, THREE.MeshBasicMaterial]> = [
    [0.33 * scale, redMat, redHaloMat],
    [0, yellowMat, yellowHaloMat],
    [-0.33 * scale, greenMat, greenHaloMat],
  ];
  for (const [ly, lMat, hMat] of items) {
    const lens = new THREE.Mesh(lensGeo, lMat);
    lens.position.set(0, ly, -d * 0.5 - 0.006);
    lens.rotation.y = Math.PI;

    const halo = new THREE.Mesh(haloGeo, hMat);
    halo.position.set(0, ly, -d * 0.5 - 0.014);
    halo.rotation.y = Math.PI;

    const visor = new THREE.Mesh(visorGeo, mats.signalBodyMat);
    visor.rotation.order = "YXZ";
    visor.rotation.x = Math.PI / 2;
    visor.rotation.z = Math.PI;
    visor.position.set(0, ly + lensR * 0.08, -d * 0.5 - 0.075 * scale);

    head.add(lens, halo, visor);
  }
  return head;
}

/**
 * Инстансинг несущих конструкций светофоров в больших OSM-сценах.
 * Сигнальные головки, линзы и управляемые материалы остаются отдельными.
 */
export function buildOsmTrafficSignalSupportInstances(
  group: THREE.Group,
  signals: TrafficSignalDef[],
  mats: RoadMaterialPack
): void {
  const cellSize = 96;
  const cells = new Map<string, TrafficSignalDef[]>();
  for (const signal of signals) {
    const key = `${Math.floor(signal.x / cellSize)},${Math.floor(signal.z / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(signal);
    cells.set(key, bucket);
  }

  const foundGeo = new THREE.CylinderGeometry(0.19, 0.23, 0.24, 8);
  const flangeGeo = new THREE.CylinderGeometry(0.16, 0.17, 0.05, 8);
  const poleGeo = new THREE.CylinderGeometry(0.068, 0.095, 1, 8);
  const cabinetGeo = new THREE.BoxGeometry(0.24, 0.38, 0.16);
  const armGeo = new THREE.CylinderGeometry(0.052, 0.066, 1, 8);
  const braceGeo = new THREE.CylinderGeometry(0.028, 0.028, 1, 6);
  const dummy = new THREE.Object3D();

  for (const [key, bucket] of cells) {
    const [gx, gz] = key.split(",").map(Number);
    const centerX = (gx + 0.5) * cellSize;
    const centerZ = (gz + 0.5) * cellSize;
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.position.set(centerX, 0, centerZ);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    };
    const regular = bucket.filter((signal) => signal.stopLineWidth < 4);
    const mast = bucket.filter((signal) => signal.stopLineWidth >= 4);
    const addBaseParts = (items: TrafficSignalDef[], poleH: number) => {
      if (!items.length) return;
      const found = make(foundGeo, mats.concreteBaseMat, items.length);
      const flange = make(flangeGeo, mats.darkIronMat, items.length);
      const pole = make(poleGeo, mats.galvPoleMat, items.length);
      const cabinet = make(cabinetGeo, mats.galvPoleMat, items.length);
      items.forEach((signal, index) => {
        const x = signal.x - centerX;
        const z = signal.z - centerZ;
        const set = (mesh: THREE.InstancedMesh, px: number, py: number, pz: number, scaleY = 1) => {
          dummy.position.set(x + px * Math.cos(signal.h) + pz * Math.sin(signal.h), py, z - px * Math.sin(signal.h) + pz * Math.cos(signal.h));
          dummy.rotation.set(0, signal.h, 0);
          dummy.scale.set(1, scaleY, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(index, dummy.matrix);
        };
        set(found, 0, 0.12, 0);
        set(flange, 0, 0.26, 0);
        set(pole, 0, poleH * 0.5, 0, poleH);
        set(cabinet, 0, 1.25, 0.1);
      });
      for (const mesh of [found, flange, pole, cabinet]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    };
    addBaseParts(regular, 4.15);
    addBaseParts(mast, 5.65);

    if (mast.length) {
      const arms = make(armGeo, mats.galvPoleMat, mast.length);
      const braces = make(braceGeo, mats.galvPoleMat, mast.length);
      mast.forEach((signal, index) => {
        const x = signal.x - centerX;
        const z = signal.z - centerZ;
        const armSpan = Math.min(3.4, Math.max(2.2, signal.stopLineWidth * 0.62));
        dummy.position.set(x + (armSpan * 0.5) * Math.cos(signal.h), 5.5, z - (armSpan * 0.5) * Math.sin(signal.h));
        dummy.rotation.set(0, signal.h, 0);
        dummy.rotateZ(-Math.PI / 2);
        dummy.scale.set(1, armSpan, 1);
        dummy.updateMatrix();
        arms.setMatrixAt(index, dummy.matrix);

        dummy.position.set(x + 0.42 * Math.cos(signal.h), 5.09, z - 0.42 * Math.sin(signal.h));
        dummy.rotation.set(0, signal.h, 0);
        dummy.rotateZ(-Math.PI / 4);
        dummy.scale.set(1, 1.15, 1);
        dummy.updateMatrix();
        braces.setMatrixAt(index, dummy.matrix);
      });
      for (const mesh of [arms, braces]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    }
  }
}

/** Строит светофорный пост ГОСТ Р 52282: стоп-линия 1.12, опора, табличка 6.16 «СТОП», Т.1, Г-консоль и П.1. */
export function buildGostTrafficSignal(
  group: THREE.Group,
  sig: TrafficSignalDef,
  mats: RoadMaterialPack,
  includeSupport = true
): GostSignalVisualHandle {
  // Широкая стоп-линия 1.12 (0.40 м)
  const stopLine = new THREE.Mesh(new THREE.PlaneGeometry(sig.stopLineWidth, 0.42), mats.whiteMarkMat);
  stopLine.rotation.order = "YXZ";
  stopLine.rotation.y = sig.h;
  stopLine.rotation.x = -Math.PI / 2;
  stopLine.position.set(sig.stopLineX, 0.029, sig.stopLineZ);
  group.add(stopLine);

  const redMat = new THREE.MeshBasicMaterial({ color: 0x380c0c });
  const yellowMat = new THREE.MeshBasicMaterial({ color: 0x382b08 });
  const greenMat = new THREE.MeshBasicMaterial({ color: 0x08351d });
  const makeHalo = (hex: number) =>
    new THREE.MeshBasicMaterial({
      map: mats.haloTex,
      color: hex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  const redHaloMat = makeHalo(0xff3b3b);
  const yellowHaloMat = makeHalo(0xffcc29);
  const greenHaloMat = makeHalo(0x22e584);
  const pedRedMat = new THREE.MeshBasicMaterial({ color: 0x380c0c });
  const pedGreenMat = new THREE.MeshBasicMaterial({ color: 0x08351d });

  const g = new THREE.Group();
  g.position.set(sig.x, 0, sig.z);
  g.rotation.y = sig.h;

  const hasMastArm = sig.stopLineWidth >= 4.0;
  const poleH = hasMastArm ? 5.65 : 4.15;

  // Бетонный фундамент, анкерный фланец, гранёная оцинкованная опора и клеммный шкаф
  if (includeSupport) {
    const found = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.23, 0.24, 8), mats.concreteBaseMat);
    found.position.y = 0.12;
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.05, 8), mats.darkIronMat);
    flange.position.y = 0.26;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.095, poleH, 8), mats.galvPoleMat);
    pole.position.y = poleH * 0.5;
    pole.castShadow = true;
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.38, 0.16), mats.galvPoleMat);
    cabinet.position.set(0, 1.25, 0.1);
    g.add(found, flange, pole, cabinet);
  }

  // Табличка 6.16 «СТОП» на опоре под основной секцией
  const stopPlaque = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.24), mats.stopPlaqueMat);
  stopPlaque.position.set(0, 2.28, -0.105);
  stopPlaque.rotation.y = Math.PI;
  const stopBack = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.22), mats.signBackMat);
  stopBack.position.set(0, 2.28, -0.095);
  g.add(stopPlaque, stopBack);

  // Основная правая головка Т.1 на уровне глаз водителя (y = 3.35 м)
  const mainHead = makeSignalHeadT1(
    1.0,
    mats,
    redMat,
    yellowMat,
    greenMat,
    redHaloMat,
    yellowHaloMat,
    greenHaloMat
  );
  mainHead.position.set(0, 3.38, -0.14);
  g.add(mainHead);

  // Выносная Г-образная консоль с дублирующей головкой Т.1 (Ø300 мм) над полосой движения
  if (hasMastArm) {
    const armSpan = Math.min(3.4, Math.max(2.2, sig.stopLineWidth * 0.62));
    if (includeSupport) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.066, armSpan, 8), mats.galvPoleMat);
      arm.rotation.z = -Math.PI / 2;
      arm.position.set(armSpan * 0.5, poleH - 0.15, 0);
      arm.castShadow = true;

      // Раскос жёсткости консоли
      const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.15, 6), mats.galvPoleMat);
      brace.rotation.z = -Math.PI / 4;
      brace.position.set(0.42, poleH - 0.56, 0);
      g.add(arm, brace);
    }

    const overHead = makeSignalHeadT1(
      1.12,
      mats,
      redMat,
      yellowMat,
      greenMat,
      redHaloMat,
      yellowHaloMat,
      greenHaloMat
    );
    overHead.position.set(armSpan - 0.25, poleH - 0.22, -0.14);
    g.add(overHead);
  }

  // Боковая двухсекционная пешеходная головка П.1 (обращена поперёк дороги к переходящим)
  const pedHead = new THREE.Group();
  pedHead.position.set(0.18, 2.52, 0);
  pedHead.rotation.y = Math.PI / 2;
  const pedBox = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.52, 0.16), mats.signalBodyMat);
  const pedBorder = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.57, 0.016), mats.signalBorderMat);
  pedBorder.position.z = -0.068;
  const pLensGeo = new THREE.CircleGeometry(0.078, 14);
  const pRed = new THREE.Mesh(pLensGeo, pedRedMat);
  pRed.position.set(0, 0.12, -0.084);
  pRed.rotation.y = Math.PI;
  const pGrn = new THREE.Mesh(pLensGeo, pedGreenMat);
  pGrn.position.set(0, -0.12, -0.084);
  pGrn.rotation.y = Math.PI;
  pedHead.add(pedBorder, pedBox, pRed, pGrn);
  g.add(pedHead);

  group.add(g);
  return { def: sig, redMat, yellowMat, greenMat, redHaloMat, yellowHaloMat, greenHaloMat, pedRedMat, pedGreenMat };
}

/** Определяет угол поворота мачты освещения в сторону ближайшей проезжей части. */
function findAimAngleToNearestRoad(x: number, z: number, world: WorldData): number {
  let bestD2 = Infinity;
  let bestDx = 1;
  let bestDz = 0;
  for (const r of world.roads) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const lenSq = abx * abx + abz * abz;
      const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq)) : 0;
      const dx = a.x + abx * t - x;
      const dz = a.z + abz * t - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2 && d2 > 0.04) {
        bestD2 = d2;
        bestDx = dx;
        bestDz = dz;
      }
    }
  }
  return Math.atan2(bestDx, bestDz);
}

/**
 * Инстансинг городских мачт освещения для больших OSM-сцен.
 * Каждая ячейка 96×96 м получает отдельные InstancedMesh по компонентам/материалам.
 * Геометрия и ориентация соответствуют обычной мачте из buildGostStreetProp.
 */
export function buildOsmStreetLightInstances(
  group: THREE.Group,
  poles: ObstacleBox[],
  world: WorldData,
  mats: RoadMaterialPack
): void {
  const cellSize = 96;
  const cells = new Map<string, ObstacleBox[]>();
  for (const pole of poles) {
    if (pole.height < 2.2) continue;
    const gx = Math.floor(pole.cx / cellSize);
    const gz = Math.floor(pole.cz / cellSize);
    const key = `${gx},${gz}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(pole);
    cells.set(key, bucket);
  }

  const unit = {
    plinth: new THREE.CylinderGeometry(0.13, 0.17, 0.85, 8),
    shaft: new THREE.CylinderGeometry(0.055, 0.105, 1, 8),
    arm: new THREE.CylinderGeometry(0.032, 0.045, 1, 7),
    lamp: new THREE.BoxGeometry(0.28, 0.09, 0.62),
    diffuser: new THREE.PlaneGeometry(0.22, 0.48),
  };
  const dummy = new THREE.Object3D();

  for (const [key, bucket] of cells) {
    const [gx, gz] = key.split(",").map(Number);
    const centerX = (gx + 0.5) * cellSize;
    const centerZ = (gz + 0.5) * cellSize;
    const makeBatch = (geometry: THREE.BufferGeometry, material: THREE.Material, castShadow = false) => {
      const mesh = new THREE.InstancedMesh(geometry, material, bucket.length);
      mesh.position.set(centerX, 0, centerZ);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      return mesh;
    };
    const plinths = makeBatch(unit.plinth, mats.darkIronMat);
    const shafts = makeBatch(unit.shaft, mats.galvPoleMat);
    const arms = makeBatch(unit.arm, mats.galvPoleMat);
    const lamps = makeBatch(unit.lamp, mats.darkIronMat);
    const diffusers = makeBatch(unit.diffuser, mats.luminaireGlowMat);

    bucket.forEach((pole, index) => {
      const yaw = findAimAngleToNearestRoad(pole.cx, pole.cz, world);
      const x = pole.cx - centerX;
      const z = pole.cz - centerZ;
      const h = Math.max(4.6, pole.height * 1.45);
      const place = (mesh: THREE.InstancedMesh, px: number, py: number, pz: number, rx = 0, ry = yaw, rz = 0, sx = 1, sy = 1, sz = 1) => {
        dummy.position.set(x + px * Math.cos(yaw) + pz * Math.sin(yaw), py, z - px * Math.sin(yaw) + pz * Math.cos(yaw));
        dummy.rotation.set(rx, ry, rz);
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      };

      place(plinths, 0, 0.425, 0);
      place(shafts, 0, 0.7 + (h - 0.7) * 0.5, 0, 0, yaw, 0, 1, h - 0.7, 1);
      place(arms, 0, h + 0.18, 0.58, Math.PI * 0.37);
      place(lamps, 0, h + 0.42, 1.28);
      place(diffusers, 0, h + 0.372, 1.28, Math.PI / 2);
    });

    for (const mesh of [plinths, shafts, arms, lamps, diffusers]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
}

/**
 * Строит элементы дорожной инфраструктуры РФ/СНГ (`cone`, `pole`, `fence`, `island`, `curb`).
 * Возвращает `true`, если препятствие отрисовано (здания, деревья и авто остаются за `SceneController`).
 */
export function buildGostStreetProp(
  group: THREE.Group,
  obs: ObstacleBox,
  world: WorldData,
  mats: RoadMaterialPack
): boolean {
  if (obs.kind === "cone") {
    // Сигнальный дорожный конус КС-2.2 по ГОСТ 32758: резиновая восьмиугольная база + 2 белые световозвращающие полосы
    const g = new THREE.Group();
    g.position.set(obs.cx, 0, obs.cz);
    const h = Math.max(0.45, obs.height);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.045, 8), mats.darkIronMat);
    base.position.y = 0.0225;
    base.receiveShadow = true;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.135, h, 14),
      new THREE.MeshStandardMaterial({ color: 0xf95b12, roughness: 0.42 })
    );
    cone.position.y = h * 0.5 + 0.035;
    cone.castShadow = true;

    const addBand = (fracY: number, bh: number) => {
      const yTop = fracY + bh * 0.5;
      const yBot = fracY - bh * 0.5;
      const rAt = (f: number) => Math.max(0.02, 0.137 * (1 - f));
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(rAt(yTop), rAt(yBot), h * bh, 14),
        mats.reflWhiteMat
      );
      band.position.y = 0.035 + h * fracY;
      g.add(band);
    };
    addBand(0.72, 0.15);
    addBand(0.42, 0.13);
    g.add(base, cone);
    group.add(g);
    return true;
  }

  if (obs.kind === "pole") {
    const g = new THREE.Group();
    g.position.set(obs.cx, 0, obs.cz);

    if (obs.height >= 2.2) {
      // Городская мачта уличного освещения ОГК с тумбой, выносным кронштейном и LED-светильником
      g.rotation.y = findAimAngleToNearestRoad(obs.cx, obs.cz, world);
      const h = Math.max(4.6, obs.height * 1.45);
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.85, 8), mats.darkIronMat);
      plinth.position.y = 0.425;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.105, h - 0.7, 8), mats.galvPoleMat);
      shaft.position.y = 0.7 + (h - 0.7) * 0.5;
      shaft.castShadow = true;

      // Наклонный выносной кронштейн в сторону проезжей части (+Z группы)
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.045, 1.35, 7), mats.galvPoleMat);
      arm.rotation.x = Math.PI * 0.37;
      arm.position.set(0, h + 0.18, 0.58);

      // Литой корпус светодиодного консольного светильника и светящийся рассеиватель
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.62), mats.darkIronMat);
      lamp.position.set(0, h + 0.42, 1.28);
      const diffuser = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.48), mats.luminaireGlowMat);
      diffuser.rotation.x = Math.PI / 2;
      diffuser.position.set(0, h + 0.372, 1.28);

      g.add(plinth, shaft, arm, lamp, diffuser);
    } else {
      // Чугунный дорожный/антипарковочный столбик ГОСТ со световозвращающими поясками
      const h = Math.max(0.75, obs.height);
      const r = Math.max(0.065, Math.min(0.11, Math.min(obs.halfX, obs.halfZ)));
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.35, r * 1.5, 0.08, 10), mats.darkIronMat);
      collar.position.y = 0.04;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r, h, 10), mats.darkIronMat);
      body.position.y = h * 0.5;
      body.castShadow = true;
      const top = new THREE.Mesh(new THREE.SphereGeometry(r * 0.96, 10, 8), mats.darkIronMat);
      top.position.y = h;
      const bandW = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.065, 10), mats.reflWhiteMat);
      bandW.position.y = h * 0.78;
      const bandR = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.98, r * 0.98, 0.045, 10), mats.reflRedMat);
      bandR.position.y = h * 0.66;
      g.add(collar, body, top, bandW, bandR);
    }
    group.add(g);
    return true;
  }

  if (obs.kind === "fence") {
    const fg = new THREE.Group();
    fg.position.set(obs.cx, 0, obs.cz);
    fg.rotation.y = obs.h;
    const alongX = obs.halfX >= obs.halfZ;
    const span = (alongX ? obs.halfX : obs.halfZ) * 2;
    const h = Math.max(0.65, obs.height);

    if (h >= 1.65) {
      // Глухой секционный забор (профлист / бетонная ограда) на столбах с верхней планкой
      const panelMat = new THREE.MeshStandardMaterial({
        color: obs.color ?? 0x4b5b66,
        roughness: 0.62,
        metalness: 0.28,
      });
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? span : 0.06, h - 0.12, alongX ? 0.06 : span),
        panelMat
      );
      panel.position.y = h * 0.5 + 0.04;
      panel.castShadow = true;
      panel.receiveShadow = true;
      const capRail = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? span + 0.04 : 0.11, 0.05, alongX ? 0.11 : span + 0.04),
        mats.darkIronMat
      );
      capRail.position.y = h;
      fg.add(panel, capRail);

      const posts = Math.max(2, Math.min(20, Math.round(span / 2.5) + 1));
      for (let i = 0; i < posts; i++) {
        const pos = posts === 1 ? 0 : (i / (posts - 1) - 0.5) * Math.max(0.2, span - 0.1);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, h + 0.04, 0.1), mats.darkIronMat);
        post.position.set(alongX ? pos : 0, (h + 0.04) * 0.5, alongX ? 0 : pos);
        fg.add(post);
      }
    } else {
      // Городское пешеходное перильное ограждение ПО-2 ГОСТ (стойки с шариками + поручни + крестовые секции)
      const railMat = new THREE.MeshStandardMaterial({
        color: obs.color ?? 0x6b7785,
        metalness: 0.42,
        roughness: 0.48,
      });
      for (const ry of [h * 0.92, h * 0.76, h * 0.18]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(alongX ? span : 0.055, 0.05, alongX ? 0.055 : span),
          railMat
        );
        rail.position.y = ry;
        rail.castShadow = true;
        fg.add(rail);
      }
      const sections = Math.max(1, Math.min(22, Math.round(span / 1.9)));
      const secLen = span / sections;
      const diagH = h * 0.56;
      const diagLen = Math.hypot(secLen * 0.86, diagH);
      const diagTilt = Math.atan2(diagH, secLen * 0.86);

      for (let i = 0; i <= sections; i++) {
        const pos = -span * 0.5 + i * secLen;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.075, h, 0.075), railMat);
        post.position.set(alongX ? pos : 0, h * 0.5, alongX ? 0 : pos);
        post.castShadow = true;
        const finial = new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 6), railMat);
        finial.position.set(alongX ? pos : 0, h + 0.035, alongX ? 0 : pos);
        fg.add(post, finial);

        if (i < sections && secLen >= 0.7) {
          const mid = pos + secLen * 0.5;
          for (const sgn of [-1, 1]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(diagLen, 0.035, 0.035), railMat);
            if (alongX) {
              bar.rotation.z = sgn * diagTilt;
              bar.position.set(mid, h * 0.47, 0);
            } else {
              bar.rotation.order = "YXZ";
              bar.rotation.y = Math.PI / 2;
              bar.rotation.z = sgn * diagTilt;
              bar.position.set(0, h * 0.47, mid);
            }
            fg.add(bar);
          }
        }
      }
    }
    group.add(fg);
    return true;
  }

  if (obs.kind === "island") {
    // Направляющий островок безопасности в чёрно-белом ГОСТ-бордюре с плиткой/газоном и сигнальными катафотами
    const ig = new THREE.Group();
    ig.position.set(obs.cx, 0, obs.cz);
    ig.rotation.y = obs.h;
    const h = Math.max(0.15, obs.height);
    const w = obs.halfX * 2;
    const l = obs.halfZ * 2;

    const curb = new THREE.Mesh(makeCurbBoxGeo(w, h, l, w > l), mats.curbBwMat);
    curb.position.y = h * 0.5;
    curb.receiveShadow = true;
    curb.castShadow = true;
    ig.add(curb);

    if (obs.halfX > 0.28 && obs.halfZ > 0.28) {
      const top = new THREE.Mesh(makeWorldUvPlane(w - 0.34, l - 0.34, 2.0), mats.sidewalkMat);
      top.rotation.x = -Math.PI / 2;
      top.position.y = h + 0.012;
      top.receiveShadow = true;
      ig.add(top);

      // Компактные сигнальные столбики-делиниаторы с жёлтым катафотом на торцах островка
      if (Math.max(w, l) >= 2.2) {
        const alongZ = l >= w;
        const off = (alongZ ? obs.halfZ : obs.halfX) - 0.28;
        for (const sgn of [-1, 1]) {
          const delin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.52, 0.05), mats.darkIronMat);
          const refl = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.26, 0.06), mats.reflYellowMat);
          const px = alongZ ? 0 : sgn * off;
          const pz = alongZ ? sgn * off : 0;
          delin.position.set(px, h + 0.26, pz);
          refl.position.set(px, h + 0.34, pz);
          if (!alongZ) {
            delin.rotation.y = Math.PI / 2;
            refl.rotation.y = Math.PI / 2;
          }
          ig.add(delin, refl);
        }
      }
    }
    group.add(ig);
    return true;
  }

  if (obs.kind === "curb") {
    // Бордюрный камень БР 100.30.15 с чёрно-белой покраской ГОСТ (на автодроме и у карманов) или бетонной расшивкой
    const alongX = obs.halfX >= obs.halfZ;
    const len = (alongX ? obs.halfX : obs.halfZ) * 2;
    const thick = (alongX ? obs.halfZ : obs.halfX) * 2;
    const isBoundaryCurb = obs.id.startsWith("boundary-curb-");
    const useBw = !isBoundaryCurb || world.roads.length <= 1;
    const mesh = new THREE.Mesh(
      makeCurbBoxGeo(thick, obs.height, len, alongX),
      useBw ? mats.curbBwMat : mats.curbGreyMat
    );
    mesh.position.set(obs.cx, obs.height * 0.5, obs.cz);
    mesh.rotation.y = obs.h;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
    return true;
  }

  return false;
}
