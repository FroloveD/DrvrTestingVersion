/**
 * @module render/roadInfra
 * @layer three-render
 * @role Пакетная 3D-генерация дорог, тротуаров, бордюров БР 100.30.15, разметки, переходов 1.14.1, светофоров Т.1/П.1, знаков и уличной инфраструктуры РФ/СНГ по ГОСТ.
 * @invariants #1 (координаты +Z вперёд, +X влево), #8 (100 % офлайн), #13 (статичность на холостом старте, O(1) индекс и слияние мешей для быстрых OSM-карт).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
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
} from "./roadTextures";
import { RoadSpatialIndex, type SpatialChunkBatcher } from "./staticBatcher";

export type GostSignalVisualHandle = {
  def: TrafficSignalDef;
  lensGroup: THREE.Group;
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
  coneOrangeMat: THREE.MeshStandardMaterial;
  reflRedMat: THREE.MeshBasicMaterial;
  reflWhiteMat: THREE.MeshBasicMaterial;
  reflYellowMat: THREE.MeshBasicMaterial;
  haloTex: THREE.CanvasTexture;
  signFaceCache: Map<string, THREE.MeshBasicMaterial>;
  fenceSolidCache: Map<number, THREE.MeshStandardMaterial>;
  fenceRailCache: Map<number, THREE.MeshStandardMaterial>;
  sharedLensGeo: THREE.CircleGeometry;
  sharedHaloGeo: THREE.PlaneGeometry;
  protos: {
    cyl8: THREE.BufferGeometry;
    taperPole: THREE.BufferGeometry;
    cone10: THREE.BufferGeometry;
    coneBandTop: THREE.BufferGeometry;
    coneBandBot: THREE.BufferGeometry;
    finial: THREE.BufferGeometry;
    visor: THREE.BufferGeometry;
    unitBox: THREE.BufferGeometry;
    backplates: Record<SignBackplateForm, THREE.BufferGeometry>;
  };
};

function createUnitBackplate(form: SignBackplateForm): THREE.BufferGeometry {
  const r = 0.47;
  switch (form) {
    case "circle":
      return new THREE.CircleGeometry(r, 20);
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
      return new THREE.PlaneGeometry(0.9, 0.82);
    case "shield_519":
      return new THREE.PlaneGeometry(0.95, 0.95);
    case "square":
      return new THREE.PlaneGeometry(0.89, 0.89);
  }
}

/** Создаёт общий пул ГОСТ-материалов, кешей знаков/ограждений и единичных прототипов на `loadWorld`. */
export function createRoadMaterialPack(): RoadMaterialPack {
  const asphalt = makeGostAsphaltMaps();
  const paver = makeSidewalkPaverMaps();
  const haloTex = makeSignalHaloTexture();

  const visor = new THREE.CylinderGeometry(0.127, 0.127, 0.16, 10, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
  visor.rotateX(-Math.PI / 2);

  return {
    asphaltMat: new THREE.MeshStandardMaterial({
      map: asphalt.map,
      bumpMap: asphalt.bumpMap,
      bumpScale: 0.016,
      roughness: 0.9,
      metalness: 0.03,
    }),
    laneWearMat: new THREE.MeshBasicMaterial({ map: makeLaneWearTexture(), transparent: true, depthWrite: false }),
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
    arrowMat: new THREE.MeshBasicMaterial({ map: makeGostArrow118Texture(), transparent: true, depthWrite: false }),
    manholeMat: new THREE.MeshBasicMaterial({ map: makeManholeTexture(), transparent: true, depthWrite: false }),
    grateMat: new THREE.MeshBasicMaterial({ map: makeStormGrateTexture() }),
    galvPoleMat: new THREE.MeshStandardMaterial({ color: 0x9aa6b4, metalness: 0.52, roughness: 0.42 }),
    darkIronMat: new THREE.MeshStandardMaterial({ color: 0x2b333d, metalness: 0.45, roughness: 0.52 }),
    concreteBaseMat: new THREE.MeshStandardMaterial({ color: 0x7d8690, roughness: 0.9 }),
    signBackMat: new THREE.MeshStandardMaterial({ color: 0x7c8896, metalness: 0.45, roughness: 0.48 }),
    signalBodyMat: new THREE.MeshStandardMaterial({ color: 0x151b23, roughness: 0.55, metalness: 0.2 }),
    signalBorderMat: new THREE.MeshBasicMaterial({ color: 0xf1f5f9 }),
    stopPlaqueMat: new THREE.MeshBasicMaterial({ map: makeStopPlaqueTexture(), transparent: true, alphaTest: 0.08 }),
    cw519RightMat: new THREE.MeshBasicMaterial({ map: makeCrosswalkSignTexture(false), transparent: true, alphaTest: 0.08 }),
    cw519LeftMat: new THREE.MeshBasicMaterial({ map: makeCrosswalkSignTexture(true), transparent: true, alphaTest: 0.08 }),
    luminaireGlowMat: new THREE.MeshBasicMaterial({ color: 0xfef3c7 }),
    coneOrangeMat: new THREE.MeshStandardMaterial({ color: 0xf95b12, roughness: 0.42 }),
    reflRedMat: new THREE.MeshBasicMaterial({ color: 0xef4444 }),
    reflWhiteMat: new THREE.MeshBasicMaterial({ color: 0xf8fafc }),
    reflYellowMat: new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
    haloTex,
    signFaceCache: new Map(),
    fenceSolidCache: new Map(),
    fenceRailCache: new Map(),
    sharedLensGeo: new THREE.CircleGeometry(1, 14),
    sharedHaloGeo: new THREE.PlaneGeometry(1, 1),
    protos: {
      cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
      taperPole: new THREE.CylinderGeometry(0.68, 1, 1, 8),
      cone10: new THREE.ConeGeometry(0.135, 1, 10),
      coneBandTop: new THREE.CylinderGeometry(0.028, 0.049, 1, 10),
      coneBandBot: new THREE.CylinderGeometry(0.071, 0.089, 1, 10),
      finial: new THREE.OctahedronGeometry(0.052, 0),
      visor,
      unitBox: new THREE.BoxGeometry(1, 1, 1),
      backplates: {
        circle: createUnitBackplate("circle"),
        octagon: createUnitBackplate("octagon"),
        triangle_down: createUnitBackplate("triangle_down"),
        diamond: createUnitBackplate("diamond"),
        rect_living: createUnitBackplate("rect_living"),
        shield_519: createUnitBackplate("shield_519"),
        square: createUnitBackplate("square"),
      },
    },
  };
}

/** Освобождает временные прототипы и возвращает все материалы/текстуры/общие геометрии пакета для `dispose`. */
export function finalizeRoadMaterialPack(mats: RoadMaterialPack): {
  materials: THREE.Material[];
  textures: THREE.Texture[];
  geometries: THREE.BufferGeometry[];
} {
  mats.protos.cyl8.dispose();
  mats.protos.taperPole.dispose();
  mats.protos.cone10.dispose();
  mats.protos.coneBandTop.dispose();
  mats.protos.coneBandBot.dispose();
  mats.protos.finial.dispose();
  mats.protos.visor.dispose();
  mats.protos.unitBox.dispose();
  Object.values(mats.protos.backplates).forEach((g) => g.dispose());

  const materials: THREE.Material[] = [
    mats.asphaltMat,
    mats.laneWearMat,
    mats.sidewalkMat,
    mats.curbBwMat,
    mats.curbGreyMat,
    mats.tactileMat,
    mats.whiteMarkMat,
    mats.yellowMarkMat,
    mats.arrowMat,
    mats.manholeMat,
    mats.grateMat,
    mats.galvPoleMat,
    mats.darkIronMat,
    mats.concreteBaseMat,
    mats.signBackMat,
    mats.signalBodyMat,
    mats.signalBorderMat,
    mats.stopPlaqueMat,
    mats.cw519RightMat,
    mats.cw519LeftMat,
    mats.luminaireGlowMat,
    mats.coneOrangeMat,
    mats.reflRedMat,
    mats.reflWhiteMat,
    mats.reflYellowMat,
    ...mats.signFaceCache.values(),
    ...mats.fenceSolidCache.values(),
    ...mats.fenceRailCache.values(),
  ];
  const textures = new Set<THREE.Texture>([mats.haloTex]);
  for (const m of materials) {
    const sm = m as THREE.MeshStandardMaterial;
    for (const t of [sm.map, sm.bumpMap, sm.roughnessMap, sm.alphaMap]) {
      if (t) textures.add(t);
    }
  }
  return {
    materials,
    textures: [...textures],
    geometries: [mats.sharedLensGeo, mats.sharedHaloGeo],
  };
}

function collectClearSpans(
  dStart: number,
  dEnd: number,
  stepM: number,
  minRunM: number,
  isBlocked: (d: number) => boolean
): Array<[number, number]> {
  const span = dEnd - dStart;
  if (span < minRunM) return [];
  const samples = Math.max(2, Math.min(64, Math.ceil(span / stepM)));
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

/**
 * Пакетно строит полотно дорог, следы наката, объёмные тротуары с плиткой, ГОСТ-бордюры БР 100.30.15,
 * эстакады 11ДО, люки и разметку ГОСТ Р 51256 с O(1) пространственным индексом и слиянием по чанкам.
 */
export function buildWorldRoadsAndSidewalks(
  roadChunks: SpatialChunkBatcher,
  detailChunks: SpatialChunkBatcher,
  world: WorldData,
  mats: RoadMaterialPack
): void {
  const isStreet = (roadId: string) =>
    world.scenarioId === "city_osm" || (world.scenarioId === "custom" && roadId !== "custom-lot");

  const surfaceStreets = world.roads.filter((r) => isStreet(r.id) && (r.layer ?? 0) === 0);
  const spatial = new RoadSpatialIndex(surfaceStreets, world.crosswalks, world.bays, world.signals);
  // Дедупликация круглых стыков в общих узлах улиц (экономит ~55 % треугольников на перекрёстках)
  const emittedCaps = new Set<string>();

  let segSerial = 0;
  for (const road of world.roads) {
    const street = isStreet(road.id);
    const layerVal = road.layer ?? 0;
    const isBridge = street && layerVal > 0;
    const layerLift = isBridge ? Math.min(0.24, layerVal * 0.08) : 0;
    const isMinorService = road.highway === "service" || road.highway === "living_street";

    if (street && road.points.length >= 2) {
      const capR = road.width * 0.5;
      const capSegs = isMinorService ? 10 : 14;
      const wBucket = Math.round(road.width);
      for (let pi = 0; pi < road.points.length; pi++) {
        const vp = road.points[pi];
        const capKey = `${layerVal}:${wBucket}:${Math.round(vp.x)}:${Math.round(vp.z)}`;
        if (emittedCaps.has(capKey)) continue;
        emittedCaps.add(capKey);
        const rb = roadChunks.at(vp.x, vp.z, capR + 2.4);
        if (!isBridge && !isMinorService) {
          rb.addWorldUvDisc(mats.sidewalkMat, vp.x, 0.005 + layerLift, vp.z, capR + 2.15, 12, 2.4, true);
        }
        rb.addWorldUvDisc(mats.asphaltMat, vp.x, 0.0118 + layerLift, vp.z, capR, capSegs, 4.5, true);
      }
    }

    for (let i = 0; i < road.points.length - 1; i++) {
      const p0 = road.points[i];
      const p1 = road.points[i + 1];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;

      const angle = Math.atan2(dx, dz);
      const fx = dx / len;
      const fz = dz / len;
      const lx = fz;
      const lz = -fx;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;
      const microY = street ? (segSerial++ % 13) * 0.0001 : 0;
      const halfSpan = Math.max(len, road.width) * 0.5 + 2.2;

      // 1. Основное полотно асфальтобетона ЩМА (мировой масштаб 4.5 м)
      const asphY = 0.012 + layerLift + microY;
      const rBatch = roadChunks.at(mx, mz, halfSpan);
      rBatch.addWorldUvQuad(mats.asphaltMat, mx, asphY, mz, road.width, len, angle, 4.5, 4.5, true);

      if (!street) {
        const rimPad = 0.14;
        const dBatch = detailChunks.at(mx, mz, halfSpan);
        for (const side of [-1, 1]) {
          dBatch.addFlatQuad(
            mats.whiteMarkMat,
            mx + lx * side * (road.width * 0.5 - 0.22),
            0.018,
            mz + lz * side * (road.width * 0.5 - 0.22),
            0.12,
            Math.max(0.5, len - 0.5),
            angle
          );
          dBatch.addBox(
            mats.concreteBaseMat,
            mx + lx * side * (road.width * 0.5 + rimPad),
            0.03,
            mz + lz * side * (road.width * 0.5 + rimPad),
            0.22,
            0.06,
            len + 0.3,
            angle,
            { receiveShadow: true }
          );
        }
        for (const endSign of [-1, 1]) {
          dBatch.addBox(
            mats.concreteBaseMat,
            mx + fx * endSign * (len * 0.5 + rimPad),
            0.03,
            mz + fz * endSign * (len * 0.5 + rimPad),
            road.width + 0.5,
            0.06,
            0.22,
            angle,
            { receiveShadow: true }
          );
        }
        if (len >= 12) {
          dBatch.addWorldUvQuad(mats.laneWearMat, mx, 0.015, mz, 3.4, len - 1.5, angle, 3.4, 6, false, true);
        }
        continue;
      }

      // 2. Тротуары с плиткой + бордюр БР 100.30.15 / эстакада 11ДО с катафотами КД-3
      if (!isBridge && !isMinorService) {
        rBatch.addWorldUvQuad(mats.sidewalkMat, mx, 0.005 + microY, mz, road.width + 4.3, len, angle, 2.4, 2.4, true);

        const swW = 1.95;
        const swH = 0.095;
        const curbW = 0.17;
        const curbH = 0.118;
        for (const side of [-1, 1]) {
          const curbOff = side * (road.width * 0.5 + curbW * 0.5 + 0.04);
          const swOff = side * (road.width * 0.5 + curbW + swW * 0.5 + 0.04);
          const backOff = swOff + side * (swW * 0.5 + 0.045);
          const spans = collectClearSpans(0.6, len - 0.6, 2.5, 2.6, (d) => {
            const sx = p0.x + fx * d + lx * curbOff;
            const sz = p0.z + fz * d + lz * curbOff;
            return (
              (layerVal === 0 && spatial.inJunction(sx, sz, road.id, 2.3)) ||
              spatial.inCrosswalk(sx, sz, 1.1) ||
              spatial.inBayOpening(sx, sz)
            );
          });
          for (const [d0, d1] of spans) {
            const rLen = d1 - d0;
            const dMid = (d0 + d1) * 0.5;
            const bx = p0.x + fx * dMid;
            const bz = p0.z + fz * dMid;
            const dBatch = detailChunks.at(bx, bz, rLen * 0.5 + swW + 1);

            dBatch.addWorldUvQuad(
              mats.sidewalkMat,
              bx + lx * swOff,
              swH + microY,
              bz + lz * swOff,
              swW,
              rLen,
              angle,
              2.4,
              2.4,
              true
            );
            dBatch.addBox(
              mats.concreteBaseMat,
              bx + lx * backOff,
              swH * 0.5,
              bz + lz * backOff,
              0.09,
              swH,
              rLen,
              angle
            );
            const useBw = spatial.nearControlZone(bx, bz);
            dBatch.addBox(
              useBw ? mats.curbBwMat : mats.curbGreyMat,
              bx + lx * curbOff,
              curbH * 0.5,
              bz + lz * curbOff,
              curbW,
              curbH,
              rLen,
              angle,
              { receiveShadow: true, curbTileM: 2.0, curbAlongX: false }
            );
          }
        }
      } else if (isBridge) {
        rBatch.addBox(mats.concreteBaseMat, mx, asphY - 0.075, mz, road.width + 0.9, 0.14, len, angle, {
          keepBottom: true,
        });
        for (const side of [-1, 1]) {
          const gOff = side * (road.width * 0.5 + 0.24);
          rBatch.addBox(
            mats.galvPoleMat,
            mx + lx * gOff,
            asphY + 0.56,
            mz + lz * gOff,
            0.12,
            0.28,
            len,
            angle
          );
          const postCount = Math.min(28, Math.max(2, Math.floor(len / 4.2) + 1));
          for (let pk = 0; pk < postCount; pk++) {
            const pd = postCount === 1 ? len * 0.5 : (pk / (postCount - 1)) * len;
            const px = p0.x + fx * pd + lx * gOff;
            const pz = p0.z + fz * pd + lz * gOff;
            const dBatch = detailChunks.at(px, pz, 1);
            dBatch.addBox(mats.galvPoleMat, px, asphY + 0.36, pz, 0.1, 0.72, 0.1, angle);
            if (pk % 2 === 0) {
              dBatch.addBox(
                side < 0 ? mats.reflRedMat : mats.reflWhiteMat,
                px - lx * side * 0.06,
                asphY + 0.58,
                pz - lz * side * 0.06,
                0.05,
                0.1,
                0.14,
                angle
              );
            }
          }
        }
      }

      // 3. Следы наката колёс, чугунные люки ГОСТ 3634 и дождеприёмники
      const laneCount = Math.max(1, Math.min(6, Math.round(road.lanes || 2)));
      const laneW = (road.width - 0.5) / laneCount;
      if (len >= 12 && !isMinorService) {
        const wearW = Math.min(3.1, laneW * 0.86);
        const wearSpans = collectClearSpans(2, len - 2, 3.2, 6, (d) =>
          layerVal === 0 && spatial.inJunction(p0.x + fx * d, p0.z + fz * d, road.id, 1.2)
        );
        for (const [d0, d1] of wearSpans) {
          const rLen = d1 - d0;
          const dMid = (d0 + d1) * 0.5;
          const bx = p0.x + fx * dMid;
          const bz = p0.z + fz * dMid;
          const dBatch = detailChunks.at(bx, bz, rLen * 0.5 + road.width * 0.5);
          for (let li = 0; li < laneCount; li++) {
            const laneOff = ((li + 0.5) / laneCount - 0.5) * (road.width - 0.5);
            dBatch.addWorldUvQuad(
              mats.laneWearMat,
              bx + lx * laneOff,
              asphY + 0.0032,
              bz + lz * laneOff,
              wearW,
              rLen,
              angle,
              wearW,
              8,
              false,
              true
            );
          }
        }
      }

      if (!isBridge && !isMinorService && len >= 34) {
        const mhOff = -laneW * 0.35;
        const gOff = -(road.width * 0.5 - 0.28);
        for (let d = 18; d < len - 14; d += 44) {
          const cx = p0.x + fx * d;
          const cz = p0.z + fz * d;
          if (spatial.inJunction(cx, cz, road.id, 4) || spatial.inCrosswalk(cx, cz, 3) || spatial.inBayOpening(cx, cz)) {
            continue;
          }
          const dBatch = detailChunks.at(cx, cz, 8);
          dBatch.addFlatQuad(mats.manholeMat, cx + lx * mhOff, asphY + 0.0055, cz + lz * mhOff, 0.76, 0.76, angle);
          dBatch.addFlatQuad(
            mats.grateMat,
            cx + fx * 6 + lx * gOff,
            asphY + 0.0055,
            cz + fz * 6 + lz * gOff,
            0.42,
            0.82,
            angle
          );
        }
      }

      // 4. Горизонтальная дорожная разметка ГОСТ Р 51256-2018 (1.1, 1.2, 1.3, 1.5, 1.6, 1.18)
      const markY = 0.022 + layerLift + microY;
      const isMarkBlocked = (d: number) => {
        const px = p0.x + fx * d;
        const pz = p0.z + fz * d;
        return (layerVal === 0 && spatial.inJunction(px, pz, road.id, 1.45)) || spatial.inCrosswalk(px, pz, 0.7);
      };

      if (!isMinorService && road.width >= 6.8 && len > 10) {
        const edgeInset = road.width * 0.5 - 0.28;
        for (const side of [-1, 1]) {
          const eSpans = collectClearSpans(1.8, len - 1.8, 2.8, 3.0, (d) => {
            const ex = p0.x + fx * d + lx * side * edgeInset;
            const ez = p0.z + fz * d + lz * side * edgeInset;
            return (
              (layerVal === 0 && spatial.inJunction(ex, ez, road.id, 1.9)) ||
              spatial.inCrosswalk(ex, ez, 0.7) ||
              spatial.inBayOpening(ex, ez)
            );
          });
          for (const [d0, d1] of eSpans) {
            const rLen = d1 - d0;
            const dMid = (d0 + d1) * 0.5;
            const ex = p0.x + fx * dMid + lx * side * edgeInset;
            const ez = p0.z + fz * dMid + lz * side * edgeInset;
            detailChunks.at(ex, ez, rLen * 0.5 + 1).addFlatQuad(mats.whiteMarkMat, ex, markY, ez, 0.12, rLen, angle);
          }
        }
      }

      if (laneCount >= 2 && len > 8 && !isMinorService) {
        const endPad = Math.min(3.6, len * 0.18);
        const emitDashedLine = (latOffset: number) => {
          const dashCount = Math.floor(len / 5.5);
          for (let k = 0; k < dashCount; k++) {
            const d = ((k + 0.5) / dashCount) * len;
            if (isMarkBlocked(d)) continue;
            const px = p0.x + fx * d + lx * latOffset;
            const pz = p0.z + fz * d + lz * latOffset;
            const dashLen = spatial.nearControlZone(px, pz) ? 3.4 : 2.1;
            detailChunks.at(px, pz, 2).addFlatQuad(mats.whiteMarkMat, px, markY, pz, 0.13, dashLen, angle);
          }
        };

        if (road.oneway) {
          for (let div = 1; div < laneCount; div++) {
            emitDashedLine((div / laneCount - 0.5) * (road.width - 0.5));
          }
        } else {
          const isDoubleSolid = laneCount >= 4 || (road.hasSolidCenter && road.width >= 12.5);
          if (isDoubleSolid || road.hasSolidCenter) {
            const cSpans = collectClearSpans(endPad, len - endPad, 2.8, 2.2, isMarkBlocked);
            for (const [d0, d1] of cSpans) {
              const rLen = d1 - d0;
              const dMid = (d0 + d1) * 0.5;
              const cx = p0.x + fx * dMid;
              const cz = p0.z + fz * dMid;
              const dBatch = detailChunks.at(cx, cz, rLen * 0.5 + 1);
              if (isDoubleSolid) {
                for (const s of [-0.13, 0.13]) {
                  dBatch.addFlatQuad(mats.whiteMarkMat, cx + lx * s, markY, cz + lz * s, 0.12, rLen, angle);
                }
              } else {
                dBatch.addFlatQuad(mats.whiteMarkMat, cx, markY, cz, 0.14, rLen, angle);
              }
            }
          } else {
            emitDashedLine(0);
          }

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

      if (road.oneway && !isMinorService && len >= 16) {
        const arrowCount = Math.min(8, Math.max(1, Math.floor(len / 28)));
        for (let aIdx = 0; aIdx < arrowCount; aIdx++) {
          const d = ((aIdx + 0.5) / arrowCount) * len;
          if (isMarkBlocked(d)) continue;
          const bx = p0.x + fx * d;
          const bz = p0.z + fz * d;
          const dBatch = detailChunks.at(bx, bz, road.width * 0.5 + 2);
          for (let li = 0; li < laneCount; li++) {
            const off = laneCount === 1 ? 0 : ((li + 0.5) / laneCount - 0.5) * (road.width - 0.6);
            dBatch.addFlatQuad(
              mats.arrowMat,
              bx + lx * off,
              markY + 0.001,
              bz + lz * off,
              0.85,
              3.1,
              angle + Math.PI
            );
          }
        }
      }
    }
  }
}

/** Пакетно добавляет оцинкованную стойку ГОСТ с бетонным стаканом, заглушкой и двумя хомутами крепления. */
function emitSignPoleHardware(
  detailChunks: SpatialChunkBatcher,
  x: number,
  z: number,
  yaw: number,
  poleH: number,
  signY: number,
  mats: RoadMaterialPack
): void {
  const b = detailChunks.at(x, z, 1.5);
  const sh = Math.sin(yaw);
  const ch = Math.cos(yaw);
  b.addProto(mats.concreteBaseMat, mats.protos.taperPole, x, 0.09, z, 0, yaw, 0, 0.14, 0.18, 0.14);
  b.addProto(mats.galvPoleMat, mats.protos.cyl8, x, poleH * 0.5, z, 0, yaw, 0, 0.039, poleH, 0.039);
  b.addProto(mats.darkIronMat, mats.protos.cyl8, x, poleH + 0.015, z, 0, yaw, 0, 0.044, 0.04, 0.044);
  for (const dy of [-0.17, 0.17]) {
    b.addBox(mats.darkIronMat, x - sh * 0.02, signY + dy, z - ch * 0.02, 0.12, 0.045, 0.09, yaw);
  }
}

function getCachedSignFaceMat(sign: RoadSignDef, mats: RoadMaterialPack): THREE.MeshBasicMaterial {
  const key = `${sign.kind}:${sign.limitKmh ?? ""}:${sign.label ?? ""}`;
  let mat = mats.signFaceCache.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ map: makeRoadSignTexture(sign), transparent: true, alphaTest: 0.08 });
    mats.signFaceCache.set(key, mat);
  }
  return mat;
}

/** Пакетно строит дорожный знак ГОСТ Р 52290-2004 (с кешированием текстур одинаковых знаков на крупных OSM-картах). */
export function buildGostRoadSign(detailChunks: SpatialChunkBatcher, sign: RoadSignDef, mats: RoadMaterialPack): void {
  const size = sign.kind === "crosswalk" ? 0.84 : 0.74;
  const signY = 2.52;
  const sh = Math.sin(sign.h);
  const ch = Math.cos(sign.h);
  emitSignPoleHardware(detailChunks, sign.x, sign.z, sign.h, 2.86, signY, mats);

  const b = detailChunks.at(sign.x, sign.z, 1.5);
  const faceMat = getCachedSignFaceMat(sign, mats);
  // Лицевая сторона смотрит к -Z локальной системы знака (yaw + PI)
  b.addVerticalQuad(faceMat, sign.x - sh * 0.056, signY, sign.z - ch * 0.056, size, size, sign.h + Math.PI);
  const backGeo = mats.protos.backplates[getSignBackplateForm(sign.kind)];
  b.addProto(mats.signBackMat, backGeo, sign.x - sh * 0.046, signY, sign.z - ch * 0.046, 0, sign.h, 0, size, size, 1);
}

/** Пакетно строит знак 3.24 «Ограничение скорости» для встроенных `speedZones`. */
export function buildGostSpeedSign(
  detailChunks: SpatialChunkBatcher,
  limitKmh: number,
  x: number,
  z: number,
  h: number,
  mats: RoadMaterialPack
): void {
  const key = `speed324:${limitKmh}`;
  let faceMat = mats.signFaceCache.get(key);
  if (!faceMat) {
    faceMat = new THREE.MeshBasicMaterial({
      map: makeGostSpeedLimitTexture(limitKmh),
      transparent: true,
      alphaTest: 0.08,
    });
    mats.signFaceCache.set(key, faceMat);
  }
  const size = 0.74;
  const signY = 2.52;
  const sh = Math.sin(h);
  const ch = Math.cos(h);
  emitSignPoleHardware(detailChunks, x, z, h, 2.86, signY, mats);

  const b = detailChunks.at(x, z, 1.5);
  b.addVerticalQuad(faceMat, x - sh * 0.056, signY, z - ch * 0.056, size, size, h + Math.PI);
  b.addProto(mats.signBackMat, mats.protos.backplates.circle, x - sh * 0.046, signY, z - ch * 0.046, 0, h, 0, size, size, 1);
}

/** Пакетно строит пешеходный переход ГОСТ 1.14.1 (бело-жёлтая «зебра», тактильная плитка и знаки 5.19.1/5.19.2). */
export function buildGostCrosswalk(detailChunks: SpatialChunkBatcher, cw: CrosswalkDef, mats: RoadMaterialPack): void {
  const sh = Math.sin(cw.h);
  const ch = Math.cos(cw.h);
  const wx = (lx: number, lz: number) => cw.cx + lx * ch + lz * sh;
  const wz = (lx: number, lz: number) => cw.cz - lx * sh + lz * ch;
  const b = detailChunks.at(cw.cx, cw.cz, Math.max(cw.width, cw.length) * 0.5 + 2);

  const usableW = Math.max(1.8, cw.width - 0.8);
  const stripes = Math.max(3, Math.floor(cw.width / 0.82));
  for (let i = 0; i < stripes; i++) {
    const sx = ((i + 0.5) / stripes - 0.5) * usableW;
    const isYellow = i % 2 === 1;
    b.addFlatQuad(
      isYellow ? mats.yellowMarkMat : mats.whiteMarkMat,
      wx(sx, 0),
      isYellow ? 0.0255 : 0.026,
      wz(sx, 0),
      isYellow ? 0.36 : 0.44,
      cw.length,
      cw.h
    );
  }

  const tactLen = Math.min(2.8, cw.length * 0.78);
  for (const side of [-1, 1]) {
    const lx = side * (cw.width * 0.5 + 0.58);
    b.addWorldUvQuad(mats.tactileMat, wx(lx, 0), 0.104, wz(lx, 0), 0.62, tactLen, cw.h, 0.62, 0.62, true);
  }

  const emitDual519 = (lx: number, lz: number, frontIs5191: boolean) => {
    const px = wx(lx, lz);
    const pz = wz(lx, lz);
    const signY = 2.58;
    emitSignPoleHardware(detailChunks, px, pz, cw.h, 2.95, signY, mats);
    const pb = detailChunks.at(px, pz, 1.5);
    pb.addBox(mats.signBackMat, px, signY, pz, 0.82, 0.82, 0.028, cw.h);
    pb.addVerticalQuad(
      frontIs5191 ? mats.cw519RightMat : mats.cw519LeftMat,
      px - sh * 0.018,
      signY,
      pz - ch * 0.018,
      0.84,
      0.84,
      cw.h + Math.PI
    );
    pb.addVerticalQuad(
      frontIs5191 ? mats.cw519LeftMat : mats.cw519RightMat,
      px + sh * 0.018,
      signY,
      pz + ch * 0.018,
      0.84,
      0.84,
      cw.h
    );
  };

  emitDual519(-cw.width * 0.5 - 0.95, -cw.length * 0.5 - 0.55, true);
  emitDual519(cw.width * 0.5 + 0.95, cw.length * 0.5 + 0.55, false);
}

/**
 * Строит светофорный пост ГОСТ Р 52282: все статические элементы (стоп-линия 1.12, опора, Г-консоль, корпуса,
 * фоновые экраны, козырьки и табличка 6.16 «СТОП») сливаются в чанк, а динамические LED-линзы выносятся в лёгкую группу.
 */
export function buildGostTrafficSignal(
  detailChunks: SpatialChunkBatcher,
  dynamicParent: THREE.Group,
  sig: TrafficSignalDef,
  mats: RoadMaterialPack
): GostSignalVisualHandle {
  // Стоп-линия 1.12
  detailChunks
    .at(sig.stopLineX, sig.stopLineZ, sig.stopLineWidth * 0.5 + 1)
    .addFlatQuad(mats.whiteMarkMat, sig.stopLineX, 0.029, sig.stopLineZ, sig.stopLineWidth, 0.42, sig.h);

  const sh = Math.sin(sig.h);
  const ch = Math.cos(sig.h);
  const wx = (lx: number, lz: number) => sig.x + lx * ch + lz * sh;
  const wz = (lx: number, lz: number) => sig.z - lx * sh + lz * ch;
  const b = detailChunks.at(sig.x, sig.z, 5);

  const hasMastArm = sig.stopLineWidth >= 4.0;
  const poleH = hasMastArm ? 5.65 : 4.15;

  // Опора, фундамент, фланец, клеммный шкаф и табличка 6.16 «СТОП» — в общий статический бакет
  b.addProto(mats.concreteBaseMat, mats.protos.taperPole, sig.x, 0.12, sig.z, 0, sig.h, 0, 0.23, 0.24, 0.23);
  b.addProto(mats.darkIronMat, mats.protos.cyl8, sig.x, 0.26, sig.z, 0, sig.h, 0, 0.165, 0.05, 0.165);
  b.addProto(mats.galvPoleMat, mats.protos.taperPole, sig.x, poleH * 0.5, sig.z, 0, sig.h, 0, 0.095, poleH, 0.095);
  b.addBox(mats.galvPoleMat, wx(0, 0.1), 1.25, wz(0, 0.1), 0.24, 0.38, 0.16, sig.h);
  b.addVerticalQuad(mats.stopPlaqueMat, wx(0, -0.105), 2.28, wz(0, -0.105), 0.62, 0.24, sig.h + Math.PI);
  b.addVerticalQuad(mats.signBackMat, wx(0, -0.095), 2.28, wz(0, -0.095), 0.6, 0.22, sig.h);

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

  const lensGroup = new THREE.Group();
  lensGroup.position.set(sig.x, 0, sig.z);
  lensGroup.rotation.y = sig.h;

  const addHeadT1 = (hx: number, hy: number, hz: number, scale: number) => {
    const w = 0.36 * scale;
    const h = 1.06 * scale;
    const d = 0.22 * scale;
    b.addBox(mats.signalBorderMat, wx(hx, hz - d * 0.42), hy, wz(hx, hz - d * 0.42), w + 0.09 * scale, h + 0.09 * scale, 0.022, sig.h);
    b.addBox(mats.signalBodyMat, wx(hx, hz), hy, wz(hx, hz), w, h, d, sig.h, { keepBottom: true });

    const lensR = 0.118 * scale;
    const items: Array<[number, THREE.MeshBasicMaterial, THREE.MeshBasicMaterial]> = [
      [0.33 * scale, redMat, redHaloMat],
      [0, yellowMat, yellowHaloMat],
      [-0.33 * scale, greenMat, greenHaloMat],
    ];
    for (const [ly, lMat, hMat] of items) {
      const vz = hz - d * 0.5 - 0.075 * scale;
      b.addProto(mats.signalBodyMat, mats.protos.visor, wx(hx, vz), hy + ly + lensR * 0.08, wz(hx, vz), 0, sig.h, 0, scale, scale, scale);

      const lens = new THREE.Mesh(mats.sharedLensGeo, lMat);
      lens.scale.set(lensR, lensR, 1);
      lens.position.set(hx, hy + ly, hz - d * 0.5 - 0.006);
      lens.rotation.y = Math.PI;

      const halo = new THREE.Mesh(mats.sharedHaloGeo, hMat);
      const hs = lensR * 3.5;
      halo.scale.set(hs, hs, 1);
      halo.position.set(hx, hy + ly, hz - d * 0.5 - 0.014);
      halo.rotation.y = Math.PI;
      lensGroup.add(lens, halo);
    }
  };

  addHeadT1(0, 3.38, -0.14, 1.0);

  if (hasMastArm) {
    const armSpan = Math.min(3.4, Math.max(2.2, sig.stopLineWidth * 0.62));
    b.addProto(
      mats.galvPoleMat,
      mats.protos.cyl8,
      wx(armSpan * 0.5, 0),
      poleH - 0.15,
      wz(armSpan * 0.5, 0),
      0,
      sig.h,
      -Math.PI / 2,
      0.06,
      armSpan,
      0.06,
      false,
      false,
      "YXZ"
    );
    b.addProto(
      mats.galvPoleMat,
      mats.protos.cyl8,
      wx(0.42, 0),
      poleH - 0.56,
      wz(0.42, 0),
      0,
      sig.h,
      -Math.PI / 4,
      0.028,
      1.15,
      0.028,
      false,
      false,
      "YXZ"
    );
    addHeadT1(armSpan - 0.25, poleH - 0.22, -0.14, 1.12);
  }

  // Пешеходная секция П.1
  const pedYaw = sig.h + Math.PI * 0.5;
  b.addBox(mats.signalBodyMat, wx(0.18, 0), 2.52, wz(0.18, 0), 0.24, 0.52, 0.16, pedYaw, { keepBottom: true });
  b.addBox(mats.signalBorderMat, wx(0.112, 0), 2.52, wz(0.112, 0), 0.29, 0.57, 0.016, pedYaw);
  for (const [pyOff, pMat] of [
    [0.12, pedRedMat],
    [-0.12, pedGreenMat],
  ] as const) {
    const pl = new THREE.Mesh(mats.sharedLensGeo, pMat);
    pl.scale.set(0.078, 0.078, 1);
    pl.position.set(0.096, 2.52 + pyOff, 0);
    pl.rotation.y = -Math.PI * 0.5;
    lensGroup.add(pl);
  }

  dynamicParent.add(lensGroup);
  return {
    def: sig,
    lensGroup,
    redMat,
    yellowMat,
    greenMat,
    redHaloMat,
    yellowHaloMat,
    greenHaloMat,
    pedRedMat,
    pedGreenMat,
  };
}

function findAimAngleToNearestRoad(x: number, z: number, world: WorldData): number {
  let bestD2 = 900; // смотрим только в радиусе 30 м
  let bestDx = 1;
  let bestDz = 0;
  for (const r of world.roads) {
    const pts = r.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (Math.min(a.x, b.x) - x > 30 || x - Math.max(a.x, b.x) > 30) continue;
      if (Math.min(a.z, b.z) - z > 30 || z - Math.max(a.z, b.z) > 30) continue;
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
 * Пакетно записывает элементы уличной инфраструктуры РФ/СНГ (`cone`, `pole`, `fence`, `island`, `curb`) в чанки.
 * Ноль отдельных `THREE.Mesh` на секции заборов, столбики, мачты, конусы и бордюры!
 */
export function buildGostStreetProp(
  detailChunks: SpatialChunkBatcher,
  obs: ObstacleBox,
  world: WorldData,
  mats: RoadMaterialPack
): boolean {
  const p = mats.protos;

  if (obs.kind === "cone") {
    const b = detailChunks.at(obs.cx, obs.cz, 1);
    const h = Math.max(0.45, obs.height);
    b.addProto(mats.darkIronMat, p.taperPole, obs.cx, 0.0225, obs.cz, 0, 0, 0, 0.2, 0.045, 0.2, false, true);
    b.addProto(mats.coneOrangeMat, p.cone10, obs.cx, h * 0.5 + 0.035, obs.cz, 0, 0, 0, 1, h, 1, true);
    b.addProto(mats.reflWhiteMat, p.coneBandTop, obs.cx, 0.035 + h * 0.72, obs.cz, 0, 0, 0, 1, h * 0.15, 1);
    b.addProto(mats.reflWhiteMat, p.coneBandBot, obs.cx, 0.035 + h * 0.42, obs.cz, 0, 0, 0, 1, h * 0.13, 1);
    return true;
  }

  if (obs.kind === "pole") {
    const b = detailChunks.at(obs.cx, obs.cz, 2.5);
    if (obs.height >= 2.2) {
      const yaw = findAimAngleToNearestRoad(obs.cx, obs.cz, world);
      const sh = Math.sin(yaw);
      const ch = Math.cos(yaw);
      const h = Math.max(4.6, obs.height * 1.45);
      b.addProto(mats.darkIronMat, p.taperPole, obs.cx, 0.425, obs.cz, 0, yaw, 0, 0.17, 0.85, 0.17);
      b.addProto(mats.galvPoleMat, p.taperPole, obs.cx, 0.7 + (h - 0.7) * 0.5, obs.cz, 0, yaw, 0, 0.105, h - 0.7, 0.105);
      b.addProto(
        mats.galvPoleMat,
        p.cyl8,
        obs.cx + sh * 0.58,
        h + 0.18,
        obs.cz + ch * 0.58,
        Math.PI * 0.37,
        yaw,
        0,
        0.04,
        1.35,
        0.04,
        false,
        false,
        "YXZ"
      );
      const lx = obs.cx + sh * 1.28;
      const lz = obs.cz + ch * 1.28;
      b.addBox(mats.darkIronMat, lx, h + 0.42, lz, 0.28, 0.09, 0.62, yaw, { keepBottom: true });
      b.addBox(mats.luminaireGlowMat, lx, h + 0.372, lz, 0.22, 0.012, 0.48, yaw, { keepBottom: true });
    } else {
      const h = Math.max(0.75, obs.height);
      const r = Math.max(0.065, Math.min(0.11, Math.min(obs.halfX, obs.halfZ)));
      b.addProto(mats.darkIronMat, p.taperPole, obs.cx, 0.04, obs.cz, 0, 0, 0, r * 1.48, 0.08, r * 1.48);
      b.addProto(mats.darkIronMat, p.cyl8, obs.cx, h * 0.5, obs.cz, 0, 0, 0, r, h, r, true);
      b.addProto(mats.darkIronMat, p.finial, obs.cx, h + r * 0.3, obs.cz, 0, 0, 0, r * 16, r * 12, r * 16);
      b.addProto(mats.reflWhiteMat, p.cyl8, obs.cx, h * 0.78, obs.cz, 0, 0, 0, r * 1.03, 0.065, r * 1.03);
      b.addProto(mats.reflRedMat, p.cyl8, obs.cx, h * 0.66, obs.cz, 0, 0, 0, r * 1.04, 0.045, r * 1.04);
    }
    return true;
  }

  if (obs.kind === "fence") {
    const alongX = obs.halfX >= obs.halfZ;
    const span = (alongX ? obs.halfX : obs.halfZ) * 2;
    const h = Math.max(0.65, obs.height);
    const sh = Math.sin(obs.h);
    const ch = Math.cos(obs.h);
    const ptX = (pos: number) => obs.cx + (alongX ? pos * ch : pos * sh);
    const ptZ = (pos: number) => obs.cz + (alongX ? -pos * sh : pos * ch);
    const b = detailChunks.at(obs.cx, obs.cz, span * 0.5 + 1);

    if (h >= 1.65) {
      const hex = obs.color ?? 0x4b5b66;
      let panelMat = mats.fenceSolidCache.get(hex);
      if (!panelMat) {
        panelMat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.62, metalness: 0.28 });
        mats.fenceSolidCache.set(hex, panelMat);
      }
      b.addBox(panelMat, obs.cx, h * 0.5 + 0.04, obs.cz, alongX ? span : 0.06, h - 0.12, alongX ? 0.06 : span, obs.h, {
        castShadow: true,
        receiveShadow: true,
      });
      b.addBox(mats.darkIronMat, obs.cx, h, obs.cz, alongX ? span + 0.04 : 0.11, 0.05, alongX ? 0.11 : span + 0.04, obs.h);
      const posts = Math.max(2, Math.min(18, Math.round(span / 2.6) + 1));
      for (let i = 0; i < posts; i++) {
        const pos = posts === 1 ? 0 : (i / (posts - 1) - 0.5) * Math.max(0.2, span - 0.1);
        b.addBox(mats.darkIronMat, ptX(pos), (h + 0.04) * 0.5, ptZ(pos), 0.1, h + 0.04, 0.1, obs.h);
      }
    } else {
      const hex = obs.color ?? 0x6b7785;
      let railMat = mats.fenceRailCache.get(hex);
      if (!railMat) {
        railMat = new THREE.MeshStandardMaterial({ color: hex, metalness: 0.42, roughness: 0.48 });
        mats.fenceRailCache.set(hex, railMat);
      }
      for (const ry of [h * 0.92, h * 0.76, h * 0.18]) {
        b.addBox(railMat, obs.cx, ry, obs.cz, alongX ? span : 0.055, 0.05, alongX ? 0.055 : span, obs.h, {
          keepBottom: true,
        });
      }
      const sections = Math.max(1, Math.min(18, Math.round(span / 2.1)));
      const secLen = span / sections;
      const diagH = h * 0.56;
      const diagLen = Math.hypot(secLen * 0.86, diagH);
      const diagTilt = Math.atan2(diagH, secLen * 0.86);
      const barYaw = alongX ? obs.h : obs.h + Math.PI * 0.5;

      for (let i = 0; i <= sections; i++) {
        const pos = -span * 0.5 + i * secLen;
        const px = ptX(pos);
        const pz = ptZ(pos);
        b.addBox(railMat, px, h * 0.5, pz, 0.075, h, 0.075, obs.h);
        b.addProto(railMat, p.finial, px, h + 0.035, pz, 0, obs.h, 0, 1, 1, 1);

        if (i < sections && secLen >= 0.7) {
          const mid = pos + secLen * 0.5;
          const mx = ptX(mid);
          const mz = ptZ(mid);
          for (const sgn of [-1, 1]) {
            b.addProto(railMat, p.unitBox, mx, h * 0.47, mz, 0, barYaw, sgn * diagTilt, diagLen, 0.035, 0.035, false, false, "YXZ");
          }
        }
      }
    }
    return true;
  }

  if (obs.kind === "island") {
    const h = Math.max(0.15, obs.height);
    const w = obs.halfX * 2;
    const l = obs.halfZ * 2;
    const sh = Math.sin(obs.h);
    const ch = Math.cos(obs.h);
    const b = detailChunks.at(obs.cx, obs.cz, Math.max(w, l) * 0.5 + 1);
    b.addBox(mats.curbBwMat, obs.cx, h * 0.5, obs.cz, w, h, l, obs.h, {
      receiveShadow: true,
      curbTileM: 2.0,
      curbAlongX: w > l,
    });
    if (obs.halfX > 0.28 && obs.halfZ > 0.28) {
      b.addWorldUvQuad(mats.sidewalkMat, obs.cx, h + 0.012, obs.cz, w - 0.34, l - 0.34, obs.h, 2.0, 2.0, true);
      if (Math.max(w, l) >= 2.2) {
        const alongZ = l >= w;
        const off = (alongZ ? obs.halfZ : obs.halfX) - 0.28;
        const dYaw = alongZ ? obs.h : obs.h + Math.PI * 0.5;
        for (const sgn of [-1, 1]) {
          const lx = alongZ ? 0 : sgn * off;
          const lz = alongZ ? sgn * off : 0;
          const dx = obs.cx + lx * ch + lz * sh;
          const dz = obs.cz - lx * sh + lz * ch;
          b.addBox(mats.darkIronMat, dx, h + 0.26, dz, 0.12, 0.52, 0.05, dYaw);
          b.addBox(mats.reflYellowMat, dx, h + 0.34, dz, 0.09, 0.26, 0.06, dYaw);
        }
      }
    }
    return true;
  }

  if (obs.kind === "curb") {
    const alongX = obs.halfX >= obs.halfZ;
    const len = (alongX ? obs.halfX : obs.halfZ) * 2;
    const isBoundaryCurb = obs.id.startsWith("boundary-curb-");
    const useBw = !isBoundaryCurb || world.roads.length <= 1;
    detailChunks.at(obs.cx, obs.cz, len * 0.5 + 1).addBox(
      useBw ? mats.curbBwMat : mats.curbGreyMat,
      obs.cx,
      obs.height * 0.5,
      obs.cz,
      obs.halfX * 2,
      obs.height,
      obs.halfZ * 2,
      obs.h,
      { receiveShadow: true, curbTileM: 2.0, curbAlongX: alongX }
    );
    return true;
  }

  return false;
}
