/**
 * @module render/sceneController
 * @layer three-render
 * @role Изолированный 3D-рендер Three.js: процедурные текстуры и Kia Ceed JD, мир, 3 зеркала и освобождение GPU.
 * @invariants #1 (координаты), #2 (поворотники от `simTime`), #8 (three из npm, без CDN), #13 (зеркала 320×96 и 320×160).
 * @tests Смоук A, K, M (`tests/browser-smoke.mjs`)
 *
 * Оглавление секций (быстрый поиск по `grep -n "SEC:render-"`):
 * - `[SEC:render-textures]` — процедурные Canvas-текстуры (небо, асфальт, тень, фасады, знак «У», знак 3.24, номера боксов).
 * - `[SEC:render-car]`      — `createWheelMesh` и `buildProceduralCar` (кузов, полый салон, оптика, слой зеркал).
 * - `[SEC:render-init]`     — класс `SceneController`, свет, render targets зеркал, орбита и пресеты качества.
 * - `[SEC:render-world]`    — `loadWorld`, `addObstacleMesh`, `addTrafficSignal` (дороги, боксы, здания, светофоры, переходы).
 * - `[SEC:render-frame]`    — `render`, `renderInto`, `updateCamera` (поза, колёса Аккермана, троттлинг зеркал `TD-06`, камеры).
 * - `[SEC:render-dispose]`  — `getPerfMetrics`, `disposeGroup`, `dispose` (корректная очистка геометрий/материалов/текстур).
 */
import * as THREE from "three";
import { SIGN_SPEED_ZONE_PREFIX } from "../scenarios/signs";
import {
  buildRealisticTree,
  buildRussianBuilding,
  createCityEnvironmentPack,
  makeCloudySkyTexture,
  type CityEnvironmentPack,
} from "./cityBuildings";
import {
  buildGostCrosswalk,
  buildGostRoadSign,
  buildGostSpeedSign,
  buildGostStreetProp,
  buildGostTrafficSignal,
  buildWorldRoadsAndSidewalks,
  createRoadMaterialPack,
  type GostSignalVisualHandle,
  type RoadMaterialPack,
} from "./roadInfra";
import { makeGostBayStencilTexture, makeUrbanGrassTexture } from "./roadTextures";
import {
  buildDetailedCar,
  buildDetailedPedestrian,
  makeInstrumentClusterTexture,
  makeRussianLicensePlateTexture,
  type DetailedCarRig,
  type DetailedPedestrianVisual,
} from "./vehiclesAndPeds";
import type {
  CameraMode,
  ObstacleBox,
  ParkingBay,
  QualityPreset,
  SimState,
  WorldData,
} from "../sim/types";
import {
  CAR,
  clamp,
  getPedestrianPose,
  getTrafficLightPhase,
  getTurnSignalFlash,
  predictTrajectoryArc,
} from "../sim/vehicle";

// Слои относятся только к геометрии машины игрока. Мир и припаркованные авто — слой 0.
const PLAYER_EXTERIOR_LAYER = 1;
const OWN_MIRROR_HARDWARE_LAYER = 2;

type CarRig = DetailedCarRig;

type SignalVisual = GostSignalVisualHandle;

type PedestrianVisual = DetailedPedestrianVisual;

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

// === [SEC:render-textures] Процедурные Canvas-текстуры (офлайн, без внешних ассетов) ===
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

function makeLearnerSignTexture(): THREE.CanvasTexture {
  // Опознавательный знак «Учебное транспортное средство» (ПДД РФ): жёлтый фон, красная кайма, чёрная «У»
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#facc15";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#d41e24";
  g.lineWidth = 14;
  g.strokeRect(8, 8, 112, 112);
  g.fillStyle = "#0f172a";
  g.font = "900 78px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("У", 64, 69);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// === [SEC:render-car] Колёса и процедурная 3D-модель Kia Ceed JD / автопарка (см. src/render/vehiclesAndPeds.ts) ===

// === [SEC:render-init] Контроллер 3D-сцены, зеркальные буферы, орбита и пресеты качества ===
export class SceneController {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly groundMesh: THREE.Mesh;
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
    const skyTex = makeCloudySkyTexture();
    const shadowTex = makeContactShadowTexture();
    const learnerTex = makeLearnerSignTexture();
    const grassTex = makeUrbanGrassTexture();
    const playerPlateTex = makeRussianLicensePlateTexture("У 077 КС");
    const civilPlateTex = makeRussianLicensePlateTexture("А 482 МН");
    const clusterTex = makeInstrumentClusterTexture();
    grassTex.repeat.set(160, 160);
    // Индексы sharedTextures: 0 sky, 1 shadow, 2 learner, 3 grass, 4 playerPlate, 5 civilPlate, 6 cluster
    this.sharedTextures.push(skyTex, shadowTex, learnerTex, grassTex, playerPlateTex, civilPlateTex, clusterTex);
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog(0xc6dbed, 80, 235);

    this.camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.12, 420);

    // Освещение (естественный дневной свет средней полосы + тёплое солнце)
    const hemi = new THREE.HemisphereLight(0xdff0ff, 0x435244, 0.9);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff5e2, 1.38);
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

    // Травяная подложка с фактурой городского газона (масштабируется в loadWorld под реальные размеры карты)
    this.groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.95 })
    );
    this.groundMesh.scale.set(1400, 1400, 1);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.position.y = -0.02;
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    this.scene.add(this.worldGroup);

    // Детализированный учебный Kia Ceed JD (госномер ГОСТ, оптика, 5-спицевые диски, салон Supervision)
    this.playerRig = buildDetailedCar(
      "ceed",
      0xd97706,
      true,
      shadowTex,
      learnerTex,
      playerPlateTex,
      clusterTex,
      OWN_MIRROR_HARDWARE_LAYER
    );
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

  // === [SEC:render-world] Построение 3D-мира сценария, препятствий и светофоров ===
  /** Перестраивает 3D-геометрию мира при смене сценария или размеров бокса, освобождая старые ресурсы. */
  loadWorld(world: WorldData): void {
    this.disposeGroup(this.worldGroup);
    this.buildingMeshes.length = 0;
    this.signalVisuals.length = 0;
    this.pedVisuals.length = 0;
    this.checkpointMeshes.length = 0;
    this.bayVisuals.length = 0;

    // Подгоняем травяную подложку и дальность камеры под реальные размеры карты (вплоть до 6×6 км)
    const spanX = Math.max(120, world.bounds.maxX - world.bounds.minX);
    const spanZ = Math.max(120, world.bounds.maxZ - world.bounds.minZ);
    const maxSpan = Math.max(spanX, spanZ);
    const midX = (world.bounds.minX + world.bounds.maxX) * 0.5;
    const midZ = (world.bounds.minZ + world.bounds.maxZ) * 0.5;
    this.groundMesh.position.set(midX, -0.02, midZ);
    this.groundMesh.scale.set(Math.max(1400, spanX + 900), Math.max(1400, spanZ + 900), 1);

    const targetFar = maxSpan > 340 ? Math.min(2400, Math.max(520, maxSpan * 0.85)) : 420;
    if (this.camera.far !== targetFar) {
      this.camera.far = targetFar;
      this.camera.updateProjectionMatrix();
    }
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = maxSpan > 340 ? 110 : 75;
      this.scene.fog.far = maxSpan > 340 ? Math.min(560, Math.max(280, maxSpan * 0.55)) : 220;
    }

    const roadMats = createRoadMaterialPack();
    const cityEnv = createCityEnvironmentPack();
    const shadowTex = this.sharedTextures[1] as THREE.CanvasTexture;
    const learnerTex = this.sharedTextures[2] as THREE.CanvasTexture;
    const civilPlateTex = this.sharedTextures[5] as THREE.CanvasTexture;
    const clusterTex = this.sharedTextures[6] as THREE.CanvasTexture;
    const { asphaltMat, whiteMarkMat } = roadMats;

    // Масштабируем повтор текстуры газона пропорционально размеру мира (1 тайл ≈ 9 м)
    const grassTex = this.sharedTextures[3] as THREE.CanvasTexture | undefined;
    if (grassTex) {
      grassTex.repeat.set(
        Math.round(this.groundMesh.scale.x / 9),
        Math.round(this.groundMesh.scale.y / 9)
      );
    }

    // Асфальтовая площадка произвольной (неквадратной/вогнутой) формы и 3D-кромка границы мира
    const makeWorldPolygonGeo = (pts: readonly { x: number; z: number }[]): THREE.ShapeGeometry => {
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].z);
      for (let i = 1; i < pts.length; i++) {
        shape.lineTo(pts[i].x, -pts[i].z);
      }
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      if (pos && uv) {
        for (let i = 0; i < pos.count; i++) {
          uv.setXY(i, pos.getX(i) / 4.5, pos.getZ(i) / 4.5);
        }
        uv.needsUpdate = true;
      }
      geo.computeVertexNormals();
      return geo;
    };

    if (world.lotPolygon && world.lotPolygon.length >= 3) {
      // Асфальтовое полотно точно по контуру произвольной площадки (Г/Т/П-образной, трапеции, многоугольника)
      const lotMesh = new THREE.Mesh(makeWorldPolygonGeo(world.lotPolygon), asphaltMat);
      lotMesh.position.y = 0.009;
      lotMesh.receiveShadow = true;
      this.worldGroup.add(lotMesh);

      // Бетонная кромка и белая краевая разметка вдоль всех сторон произвольной площадки
      const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa6b2, roughness: 0.82 });
      const poly = world.lotPolygon;
      let area2 = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        area2 += a.x * b.z - b.x * a.z;
      }
      const outSign = area2 >= 0 ? 1 : -1;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.4) continue;
        const angle = Math.atan2(dx, dz);
        const mx = (a.x + b.x) * 0.5;
        const mz = (a.z + b.z) * 0.5;
        const nx = (outSign * dz) / len;
        const nz = (-outSign * dx) / len;

        const rim = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, len + 0.2), rimMat);
        rim.rotation.y = angle;
        rim.position.set(mx + nx * 0.12, 0.035, mz + nz * 0.12);
        rim.receiveShadow = true;
        this.worldGroup.add(rim);

        if (len > 1.2) {
          const edgeLine = new THREE.Mesh(new THREE.PlaneGeometry(0.12, len - 0.3), whiteMarkMat);
          edgeLine.rotation.order = "YXZ";
          edgeLine.rotation.y = angle;
          edgeLine.rotation.x = -Math.PI / 2;
          edgeLine.position.set(mx - nx * 0.22, 0.016, mz - nz * 0.22);
          this.worldGroup.add(edgeLine);
        }
      }
    } else if (world.boundaryPolygon && world.boundaryPolygon.length >= 3) {
      // Для городских/OSM-карт с произвольной границей: подсвеченный контур рабочей зоны по периметру
      const borderMat = new THREE.MeshBasicMaterial({ color: 0xf5b942, transparent: true, opacity: 0.62 });
      const poly = world.boundaryPolygon;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.26, len), borderMat);
        strip.rotation.order = "YXZ";
        strip.rotation.y = Math.atan2(dx, dz);
        strip.rotation.x = -Math.PI / 2;
        strip.position.set((a.x + b.x) * 0.5, 0.04, (a.z + b.z) * 0.5);
        this.worldGroup.add(strip);
      }
    }

    // Дороги, следы наката, объёмные тротуары с плиткой, ГОСТ-бордюры БР 100.30.15, эстакады 11ДО, люки и разметка ГОСТ Р 51256
    buildWorldRoadsAndSidewalks(this.worldGroup, world, roadMats);

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

      // Трафаретный номер парковочного места по ГОСТ Р 51256
      const numTex = makeGostBayStencilTexture(bay.id, bay.occupied);
      const numPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.18, 1.18),
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

    // Препятствия: автопарк, здания РФ/СНГ (панельные/кирпичные/адм.), многоярусные деревья и инфраструктура ГОСТ
    for (const obs of world.obstacles) {
      this.addObstacleMesh(obs, world, roadMats, cityEnv, shadowTex, learnerTex, civilPlateTex, clusterTex);
    }

    // Светофоры ГОСТ Р 52282 (Т.1 + Г-консоль + П.1 + табличка 6.16 «СТОП») и стоп-линии 1.12
    for (const sig of world.signals) {
      this.signalVisuals.push(buildGostTrafficSignal(this.worldGroup, sig, roadMats));
    }

    // Пешеходные переходы ГОСТ 1.14.1 (бело-жёлтая «зебра», тактильная плитка, знаки 5.19.1/5.19.2) и пешеходы
    world.crosswalks.forEach((cw, cwIdx) => {
      buildGostCrosswalk(this.worldGroup, cw, roadMats);
      const pedVis = buildDetailedPedestrian(cw.id, cwIdx, shadowTex);
      this.worldGroup.add(pedVis.group);
      this.pedVisuals.push(pedVis);
    });

    // Дорожные знаки ГОСТ Р 52290-2004 (все 12 классов, фигурная подложка, хомуты и ориентация по потоку sign.h)
    const renderedSignIds = new Set<string>();
    for (const sign of world.signs ?? []) {
      renderedSignIds.add(`${SIGN_SPEED_ZONE_PREFIX}${sign.id}`);
      buildGostRoadSign(this.worldGroup, sign, roadMats);
    }

    // Знаки ограничения скорости 3.24 (для встроенных сценариев без дублирования world.signs)
    for (const sz of world.speedZones) {
      if (renderedSignIds.has(sz.id)) continue;
      const aimH = Math.atan2(sz.x - sz.signX, sz.z - sz.signZ);
      // Поток движется от знака к центру зоны скорости (вдоль оси улицы)
      const snappedH = Math.abs(Math.cos(aimH)) >= Math.abs(Math.sin(aimH))
        ? (Math.cos(aimH) >= 0 ? 0 : Math.PI)
        : (Math.sin(aimH) >= 0 ? Math.PI / 2 : -Math.PI / 2);
      buildGostSpeedSign(this.worldGroup, sz.limitKmh, sz.signX, sz.signZ, snappedH, roadMats);
    }

    // Контрольные точки маршрута (двойной дорожный маркер с красным контуром для STOP и бирюзовым для финиша)
    for (const cp of world.checkpoints) {
      const mainHex = cp.isFinalPark ? 0x52d6bd : cp.requireStop ? 0xf87171 : 0xf5b942;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.38, 1.86, 32),
        new THREE.MeshBasicMaterial({
          color: mainHex,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.82,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cp.x, 0.04, cp.z);
      const inner = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.82, 28),
        new THREE.MeshBasicMaterial({
          color: 0xf8fafc,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.65,
        })
      );
      ring.add(inner);
      this.worldGroup.add(ring);
      this.checkpointMeshes.push({ id: cp.id, mesh: ring });
    }

    // Декоративные деревья РФ/СНГ (липы, клёны, берёзы, ели) для встроенных сценариев
    if (world.scenarioId !== "custom") {
      const treeCoords: Array<[number, number]> =
        world.scenarioId === "city_osm"
          ? [
              [-9, -42], [9, -38], [-9, -18], [9, 18], [-9, 44], [9, 48],
              [-18, 56], [-42, 72], [-70, 72], [28, -9], [-28, -9],
            ]
          : [
              [-13, -8], [13, -8], [-13, 13], [13, 13], [0, -14], [0, 18],
            ];
      treeCoords.forEach(([tx, tz], tIdx) => {
        this.worldGroup.add(buildRealisticTree(tx, tz, 4.8, cityEnv, `${world.scenarioId}-t${tIdx}`));
      });
    }

    this.resetOrbit();
    this.camLookTarget.set(world.start.x, 1.0, world.start.z);
  }

  private addObstacleMesh(
    obs: ObstacleBox,
    world: WorldData,
    roadMats: RoadMaterialPack,
    cityEnv: CityEnvironmentPack,
    shadowTex: THREE.CanvasTexture,
    learnerTex: THREE.CanvasTexture,
    civilPlateTex: THREE.CanvasTexture,
    clusterTex: THREE.CanvasTexture
  ): void {
    if (obs.kind === "parked_car" && obs.model) {
      const rig = buildDetailedCar(
        obs.model,
        obs.color ?? 0x94a3b8,
        false,
        shadowTex,
        learnerTex,
        civilPlateTex,
        clusterTex,
        OWN_MIRROR_HARDWARE_LAYER
      );
      rig.root.position.set(obs.cx, 0, obs.cz);
      rig.root.rotation.y = obs.h;
      this.worldGroup.add(rig.root);
      return;
    }

    // Дорожная инфраструктура ГОСТ РФ/СНГ (конусы КС-2.2, мачты ОГК / столбики, ограждения ПО-2, островки, бордюры БР 100.30.15)
    if (buildGostStreetProp(this.worldGroup, obs, world, roadMats)) {
      return;
    }

    if (obs.kind === "building") {
      const bld = buildRussianBuilding(obs, cityEnv);
      this.worldGroup.add(bld);
      this.buildingMeshes.push(bld);
      return;
    }

    if (obs.kind === "tree") {
      this.worldGroup.add(buildRealisticTree(obs.cx, obs.cz, Math.max(3.4, obs.height), cityEnv, obs.id));
    }
  }

  // === [SEC:render-frame] Отрисовка кадра, зеркал (320×96 и 320×160 с троттлингом TD-06) и камер ===
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

    // 4. Светофоры (Т.1 + Г-консоль + ореол + пешеходная секция П.1), пешеходы и контрольные точки
    for (const sv of this.signalVisuals) {
      const { phase } = getTrafficLightPhase(sv.def, state.time);
      const redOn = phase === "red" || phase === "red_yellow";
      const yelOn = phase === "yellow" || phase === "red_yellow";
      const grnOn = phase === "green" || (phase === "green_blink" && blinkOn);
      sv.redMat.color.setHex(redOn ? 0xff3b3b : 0x380c0c);
      sv.yellowMat.color.setHex(yelOn ? 0xffcc29 : 0x382b08);
      sv.greenMat.color.setHex(grnOn ? 0x22e584 : 0x08351d);
      sv.redHaloMat.opacity = redOn ? 0.65 : 0;
      sv.yellowHaloMat.opacity = yelOn ? 0.58 : 0;
      sv.greenHaloMat.opacity = grnOn ? 0.62 : 0;
      // Пешеходная секция П.1: зелёный горит строго при красном транспортном сигнале
      const pedGo = phase === "red";
      sv.pedRedMat.color.setHex(pedGo ? 0x380c0c : 0xff3b3b);
      sv.pedGreenMat.color.setHex(pedGo ? 0x22e584 : 0x08351d);
    }

    for (let i = 0; i < this.pedVisuals.length; i++) {
      const pv = this.pedVisuals[i];
      const cw = world.crosswalks[i];
      if (!cw) continue;
      const pose = getPedestrianPose(cw, state.time);
      pv.group.position.set(pose.x, 0, pose.z);
      pv.group.rotation.y = pose.h;
      const swing = Math.sin(pose.walkPhase) * 0.44;
      pv.legL.rotation.x = swing;
      pv.legR.rotation.x = -swing;
      pv.armL.rotation.x = -swing * 0.72;
      pv.armR.rotation.x = swing * 0.72;
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

  // === [SEC:render-dispose] Метрики FPS и освобождение GPU-ресурсов ===
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
          for (const tex of [std.map, std.bumpMap, std.roughnessMap, std.emissiveMap, std.alphaMap]) {
            if (tex && !this.sharedTextures.includes(tex)) textures.add(tex);
          }
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
