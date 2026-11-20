/**
 * @module render/sceneController
 * @layer three-render
 * @role Изолированный 3D-рендер Three.js: процедурные текстуры и Kia Ceed JD, мир, 3 зеркала и освобождение GPU.
 * @invariants #1 (координаты), #2 (поворотники от `simTime`), #8 (three из npm, без CDN), #13 (зеркала 320×96 и 320×160).
 * @tests Смоук A, K, M (`tests/browser-smoke.mjs`)
 *
 * Оглавление секций (быстрый поиск по `grep -n "SEC:render-"`):
 * - `[SEC:render-textures]` — процедурные PBR-текстуры неба, асфальта, плитки, разметки и знаков.
 * - `[SEC:render-car]`      — детализированные модели Kia Ceed, припаркованного автопарка и пешеходов.
 * - `[SEC:render-init]`     — класс `SceneController`, свет, render targets зеркал, орбита и пресеты качества.
 * - `[SEC:render-world]`    — `loadWorld`, дороги/тротуары ГОСТ, здания, деревья, светофоры, знаки и уличная инфраструктура.
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
  writeTrajectoryArcPositions,
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
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
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
  private readonly buildingBatches = new Map<string, {
    mesh: THREE.InstancedMesh;
    cursor: number;
    centerX: number;
    centerZ: number;
  }>();
  private useInstancedBuildings = false;
  private totalBuildingCount = 0;
  private readonly signalVisuals: SignalVisual[] = [];
  private readonly pedVisuals: PedestrianVisual[] = [];
  private readonly checkpointMeshes: Array<{ id: string; mesh: THREE.Object3D }> = [];
  private readonly bayVisuals: BayVisual[] = [];
  private readonly playerRig: CarRig;

  // Прогнозная траектория Аккермана
  private readonly trajGroup = new THREE.Group();
  private readonly trajLineL: THREE.Line;
  private readonly trajLineR: THREE.Line;
  private readonly trajPositionsL = new Float32Array(19 * 3);
  private readonly trajPositionsR = new Float32Array(19 * 3);
  private readonly trajAttributeL: THREE.BufferAttribute;
  private readonly trajAttributeR: THREE.BufferAttribute;
  private lastTrajectoryX = Number.NaN;
  private lastTrajectoryZ = Number.NaN;
  private lastTrajectoryH = Number.NaN;
  private lastTrajectorySteer = Number.NaN;
  private lastTrajectoryReverse: boolean | null = null;

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
  private readonly cockpitRearRT: THREE.WebGLRenderTarget;
  private readonly cockpitLeftRT: THREE.WebGLRenderTarget;
  private readonly cockpitRightRT: THREE.WebGLRenderTarget;
  private readonly cockpitRearMat: THREE.MeshBasicMaterial;
  private readonly cockpitLeftMat: THREE.MeshBasicMaterial;
  private readonly cockpitRightMat: THREE.MeshBasicMaterial;
  private readonly mirrorIdleMat: THREE.Material;
  private cockpitRearPrimed = false;
  private cockpitSidePrimed = false;
  private qualityPreset: QualityPreset = "high";
  private cockpitFov = 68;
  private lastCameraMode: CameraMode = "chase";
  private frameCounter = 0;

  // Управление орбитальной камерой
  private orbitYaw = 0;
  private orbitPitch = 0.36;
  private orbitDist = 9.2;
  private readonly cameraDesiredPos = new THREE.Vector3();
  private readonly cameraDesiredLook = new THREE.Vector3();
  private camLookTarget = new THREE.Vector3();

  // Кэш пространственного отсечения зданий: статичный список не пересчитывается каждый кадр.
  private lastBuildingCullX = Number.NaN;
  private lastBuildingCullZ = Number.NaN;
  private lastBuildingCullRadius = Number.NaN;

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
    // Count the main camera and mirror passes together for each frame.
    this.renderer.info.autoReset = false;
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
    this.sharedTextures.push(skyTex, shadowTex, learnerTex, grassTex, playerPlateTex, civilPlateTex, clusterTex);
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog(0xc6dbed, 80, 235);

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

    // Детализированный Kia Ceed JD: кузов, оптика, диски, салон и приборная панель.
    this.playerRig = buildDetailedCar(
      "ceed", 0xd97706, true, shadowTex, learnerTex, playerPlateTex, clusterTex, OWN_MIRROR_HARDWARE_LAYER
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

    // Линии прогнозной траектории: геометрия и динамические буферы создаются один раз.
    const makeTrajLine = (positions: Float32Array) => {
      const geometry = new THREE.BufferGeometry();
      const attribute = new THREE.BufferAttribute(positions, 3);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", attribute);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x52d6bd, transparent: true, opacity: 0.9 })
      );
      line.frustumCulled = false;
      return { line, attribute };
    };
    const leftTrajectory = makeTrajLine(this.trajPositionsL);
    const rightTrajectory = makeTrajLine(this.trajPositionsR);
    this.trajLineL = leftTrajectory.line;
    this.trajLineR = rightTrajectory.line;
    this.trajAttributeL = leftTrajectory.attribute;
    this.trajAttributeR = rightTrajectory.attribute;
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

    // Физические 3D-зеркала в салоне: прямой GPU-рендер без CPU readback.
    this.cockpitRearRT = new THREE.WebGLRenderTarget(512, 160, { depthBuffer: true });
    this.cockpitLeftRT = new THREE.WebGLRenderTarget(384, 240, { depthBuffer: true });
    this.cockpitRightRT = new THREE.WebGLRenderTarget(384, 240, { depthBuffer: true });
    this.cockpitRearMat = new THREE.MeshBasicMaterial({ map: this.cockpitRearRT.texture, color: 0xf6fafd });
    this.cockpitLeftMat = new THREE.MeshBasicMaterial({ map: this.cockpitLeftRT.texture, color: 0xf6fafd });
    this.cockpitRightMat = new THREE.MeshBasicMaterial({ map: this.cockpitRightRT.texture, color: 0xf6fafd });
    this.mirrorIdleMat =
      (this.playerRig.rearMirrorGlass?.material as THREE.Material | undefined) ??
      new THREE.MeshStandardMaterial({ color: 0x7d93a6, metalness: 0.88, roughness: 0.12 });

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
    if (this.lastCameraMode === "cockpit") {
      this.cockpitFov = clamp(this.cockpitFov + wheelDelta * 0.03, 50, 88);
      return;
    }
    this.orbitDist = clamp(this.orbitDist * (1 + wheelDelta * 0.0009), 4.6, 42);
  }

  resetOrbit(): void {
    this.orbitYaw = 0;
    this.orbitPitch = 0.36;
    this.orbitDist = 9.2;
    this.cockpitFov = 68;
  }

  applyQuality(preset: QualityPreset): void {
    this.qualityPreset = preset;
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
    this.lastBuildingCullX = Number.NaN;
    this.lastBuildingCullZ = Number.NaN;
    this.lastBuildingCullRadius = Number.NaN;
    this.lastTrajectoryX = Number.NaN;
    this.lastTrajectoryZ = Number.NaN;
    this.lastTrajectoryH = Number.NaN;
    this.lastTrajectorySteer = Number.NaN;
    this.lastTrajectoryReverse = null;
    this.disposeGroup(this.worldGroup);
    this.buildingMeshes.length = 0;
    this.buildingBatches.clear();
    this.useInstancedBuildings = false;
    this.totalBuildingCount = 0;
    this.signalVisuals.length = 0;
    this.pedVisuals.length = 0;
    this.checkpointMeshes.length = 0;
    this.bayVisuals.length = 0;

    // Подгоняем подложку, дальность камеры и туман под фактический размер OSM/пользовательского мира.
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
    const grassTex = this.sharedTextures[3] as THREE.CanvasTexture | undefined;
    if (grassTex) grassTex.repeat.set(Math.round(this.groundMesh.scale.x / 9), Math.round(this.groundMesh.scale.y / 9));

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

    // Для крупных OSM-районов здания объединяются в InstancedMesh по ячейкам 96×96 м.
    // Это сохраняет габариты/высоты/повороты, сокращая количество отдельных draw calls.
    const osmBuildings = world.scenarioId === "city_osm"
      ? world.obstacles.filter((obs) => obs.kind === "building")
      : [];
    this.totalBuildingCount = osmBuildings.length;
    this.useInstancedBuildings = osmBuildings.length >= 250;
    if (this.useInstancedBuildings) {
      const cells = new Map<string, ObstacleBox[]>();
      for (const obs of osmBuildings) {
        const gx = Math.floor(obs.cx / 96);
        const gz = Math.floor(obs.cz / 96);
        const key = `${gx},${gz}`;
        const bucket = cells.get(key) ?? [];
        bucket.push(obs);
        cells.set(key, bucket);
      }
      const unitBox = new THREE.BoxGeometry(1, 1, 1);
      for (const [key, bucket] of cells) {
        const [gx, gz] = key.split(",").map(Number);
        const centerX = (gx + 0.5) * 96;
        const centerZ = (gz + 0.5) * 96;
        const mesh = new THREE.InstancedMesh(
          unitBox,
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true }),
          bucket.length
        );
        mesh.position.set(centerX, 0, centerZ);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.worldGroup.add(mesh);
        this.buildingMeshes.push(mesh);
        this.buildingBatches.set(key, { mesh, cursor: 0, centerX, centerZ });
      }
    }

    // Препятствия: автопарк, здания РФ/СНГ (панельные/кирпичные/адм.), многоярусные деревья и инфраструктура ГОСТ
    for (const obs of world.obstacles) {
      this.addObstacleMesh(obs, world, roadMats, cityEnv, shadowTex, learnerTex, civilPlateTex, clusterTex);
    }
    for (const batch of this.buildingBatches.values()) {
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
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
      if (this.useInstancedBuildings) {
        const gx = Math.floor(obs.cx / 96);
        const gz = Math.floor(obs.cz / 96);
        const batch = this.buildingBatches.get(`${gx},${gz}`);
        if (batch) {
          const w = Math.max(2, obs.halfX * 2);
          const l = Math.max(2, obs.halfZ * 2);
          const h = Math.max(3.2, obs.height);
          const transform = new THREE.Object3D();
          transform.position.set(obs.cx - batch.centerX, h * 0.5, obs.cz - batch.centerZ);
          transform.rotation.y = obs.h;
          transform.scale.set(w, h, l);
          transform.updateMatrix();
          batch.mesh.setMatrixAt(batch.cursor, transform.matrix);
          const palette = [0xcfd8df, 0xd8cfc2, 0xc3d2dc, 0xb97b63, 0xc89a78, 0xdad2be];
          let hash = 0;
          for (let i = 0; i < obs.id.length; i++) hash = (Math.imul(hash, 31) + obs.id.charCodeAt(i)) | 0;
          batch.mesh.setColorAt(batch.cursor, new THREE.Color(palette[Math.abs(hash) % palette.length]));
          batch.cursor++;
        }
        return;
      }
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
    this.renderer.info.reset();
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
    if (rig.driverGroup) rig.driverGroup.visible = opts.cameraMode !== "cockpit";

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

    // 2. Отсечение дальних зданий: список статичен, поэтому обновляем его при смещении на 1 м
    // или изменении радиуса. Это убирает полный проход по тысячам зданий из каждого кадра.
    const cullDx = state.x - this.lastBuildingCullX;
    const cullDz = state.z - this.lastBuildingCullZ;
    const cullMoved = !Number.isFinite(this.lastBuildingCullX) || cullDx * cullDx + cullDz * cullDz >= 1;
    if (cullMoved || opts.drawRadius !== this.lastBuildingCullRadius) {
      const cullRadius = opts.drawRadius + (this.useInstancedBuildings ? 68 : 0);
      const r2 = cullRadius * cullRadius;
      let vis = 0;
      for (const bm of this.buildingMeshes) {
        const dx = bm.position.x - state.x;
        const dz = bm.position.z - state.z;
        const show = dx * dx + dz * dz <= r2;
        bm.visible = show;
        if (show) vis += bm instanceof THREE.InstancedMesh ? bm.count : 1;
      }
      this.visibleBuildings = vis;
      this.lastBuildingCullX = state.x;
      this.lastBuildingCullZ = state.z;
      this.lastBuildingCullRadius = opts.drawRadius;
    }

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

    // 5. Прогнозная дуга Аккермана: обновляем только при изменении входных параметров.
    this.trajGroup.visible = opts.showTrajectory;
    if (opts.showTrajectory) {
      const isRev = state.gear === "R";
      const changed =
        !Object.is(state.x, this.lastTrajectoryX) ||
        !Object.is(state.z, this.lastTrajectoryZ) ||
        !Object.is(state.h, this.lastTrajectoryH) ||
        !Object.is(state.steer, this.lastTrajectorySteer) ||
        isRev !== this.lastTrajectoryReverse;
      if (changed) {
        writeTrajectoryArcPositions(
          state.x, state.z, state.h, state.steer, isRev,
          this.trajPositionsL, this.trajPositionsR, 6.2, 18, 0.06
        );
        this.trajAttributeL.needsUpdate = true;
        this.trajAttributeR.needsUpdate = true;
        this.lastTrajectoryX = state.x;
        this.lastTrajectoryZ = state.z;
        this.lastTrajectoryH = state.h;
        this.lastTrajectorySteer = state.steer;
        this.lastTrajectoryReverse = isRev;
      }
      if (this.lastTrajectoryReverse !== null && changed) {
        const color = isRev ? 0xf5b942 : 0x52d6bd;
        (this.trajLineL.material as THREE.LineBasicMaterial).color.setHex(color);
        (this.trajLineR.material as THREE.LineBasicMaterial).color.setHex(color);
      }
    }

    // 6. Камера (обновляем матрицу кузова заранее, чтобы салон и физические зеркала не дрожали относительно головы)
    this.lastCameraMode = opts.cameraMode;
    this.playerRig.chassis.updateWorldMatrix(true, false);
    this.updateCamera(state, opts.cameraMode);

    // 7. Зеркала: в виде из салона — живое GPU-отражение прямо на физических 3D-зеркалах; снаружи — в HUD-панели
    this.frameCounter++;
    const inCockpit = opts.cameraMode === "cockpit";
    this.syncPhysicalMirrorMaterials(inCockpit && opts.showRearMirror, inCockpit && opts.showMirrors);

    if (inCockpit && (opts.showRearMirror || opts.showMirrors)) {
      const prevShadowAuto = this.renderer.shadowMap.autoUpdate;
      this.renderer.shadowMap.autoUpdate = false;
      const stride = this.qualityPreset === "low" ? 3 : 2;
      try {
        if (opts.showRearMirror && (!this.cockpitRearPrimed || this.frameCounter % stride === 0)) {
          this.renderMirrorTarget(this.cockpitRearRT, this.rearCam, 0, 1.25, 0.25, 0, -0.075, 38);
          this.cockpitRearPrimed = true;
        }
        // Боковые зеркала настроены по методике автошколы: внутренняя кромка показывает борт своего авто, остальное — полосу и бордюр
        const mountX = CAR.width / 2 + 0.13;
        if (opts.showMirrors) {
          const prime = !this.cockpitSidePrimed;
          if (prime || this.frameCounter % stride === 0) {
            this.renderMirrorTarget(this.cockpitLeftRT, this.sideCam, mountX, 0.945, 0.65, -0.37, -0.105, 44);
          }
          if (prime || this.frameCounter % stride === 1) {
            this.renderMirrorTarget(this.cockpitRightRT, this.sideCam, -mountX, 0.945, 0.65, 0.37, -0.105, 44);
          }
          this.cockpitSidePrimed = true;
        }
      } finally {
        this.renderer.shadowMap.autoUpdate = prevShadowAuto;
      }
    } else if (!inCockpit && mirrors && (opts.showMirrors || opts.showRearMirror)) {
      const prevShadowAuto = this.renderer.shadowMap.autoUpdate;
      this.renderer.shadowMap.autoUpdate = false;
      try {
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

  /** Переключает материал физических 3D-полотeн между живым отражением и амальгамным стеклом покоя. */
  private syncPhysicalMirrorMaterials(activeRear: boolean, activeSide: boolean): void {
    const rig = this.playerRig;
    if (rig.rearMirrorGlass) {
      const target = activeRear ? this.cockpitRearMat : this.mirrorIdleMat;
      if (rig.rearMirrorGlass.material !== target) rig.rearMirrorGlass.material = target;
    }
    if (rig.leftMirrorGlass) {
      const target = activeSide ? this.cockpitLeftMat : this.mirrorIdleMat;
      if (rig.leftMirrorGlass.material !== target) rig.leftMirrorGlass.material = target;
    }
    if (rig.rightMirrorGlass) {
      const target = activeSide ? this.cockpitRightMat : this.mirrorIdleMat;
      if (rig.rightMirrorGlass.material !== target) rig.rightMirrorGlass.material = target;
    }
    if (!activeRear) this.cockpitRearPrimed = false;
    if (!activeSide) this.cockpitSidePrimed = false;
  }

  /** Прямой GPU-рендер отражения в текстуру физического 3D-зеркала салона (без CPU readback). */
  private renderMirrorTarget(
    rt: THREE.WebGLRenderTarget,
    cam: THREE.PerspectiveCamera,
    localX: number,
    localY: number,
    localZ: number,
    yawOffset: number,
    pitchDown: number,
    fov: number
  ): void {
    const aspect = rt.width / rt.height;
    if (cam.fov !== fov || Math.abs(cam.aspect - aspect) > 1e-5) {
      cam.fov = fov;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    const pose = this.playerRig.chassis.matrixWorld;
    const yaw = Math.PI + yawOffset;
    cam.position.set(localX, localY, localZ).applyMatrix4(pose);
    cam.up.set(0, 1, 0).transformDirection(pose);
    cam.lookAt(
      this.mirrorLookTarget
        .set(localX + Math.sin(yaw), localY + pitchDown, localZ + Math.cos(yaw))
        .applyMatrix4(pose)
    );
    const previous = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, cam);
    } finally {
      this.renderer.setRenderTarget(previous);
    }
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

    if (mode === "cockpit") {
      // Камера рассчитывается в мировой системе координат автомобиля.
      // Это исключает влияние локальной ориентации/смещения 3D-модели кузова.
      const lx = Math.cos(s.h);
      const lz = -Math.sin(s.h);
      const eyeX = s.x + lx * (CAR.width * 0.23) - fx * 0.02;
      const eyeY = 1.19;
      const eyeZ = s.z + lz * (CAR.width * 0.23) - fz * 0.02;
      const lookYaw = s.h + this.orbitYaw * 0.65;
      const lookPitch = clamp(-0.12 - (this.orbitPitch - 0.36) * 6, -0.8, 0.55);

      if (this.camera.fov !== this.cockpitFov) {
        this.camera.fov = this.cockpitFov;
        this.camera.updateProjectionMatrix();
      }
      this.camera.position.set(eyeX, eyeY, eyeZ);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(
        eyeX + Math.sin(lookYaw) * 18,
        eyeY + lookPitch,
        eyeZ + Math.cos(lookYaw) * 18
      );
      return;
    }

    this.camera.up.set(0, 1, 0);
    if (this.camera.fov !== 55) {
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    }

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
    this.cameraDesiredPos.set(
      s.x - Math.sin(angle) * horiz,
      Math.max(1.1, Math.sin(pitch) * dist + 0.8),
      s.z - Math.cos(angle) * horiz
    );
    const lerpK = mode === "orbit" ? 0.35 : 0.16;
    this.camera.position.lerp(this.cameraDesiredPos, lerpK);
    this.cameraDesiredLook.set(s.x + fx * 1.1, 0.95, s.z + fz * 1.1);
    this.camLookTarget.lerp(this.cameraDesiredLook, 0.22);
    this.camera.lookAt(this.camLookTarget);
  }

  // === [SEC:render-dispose] Метрики FPS и освобождение GPU-ресурсов ===
  getPerfMetrics(): PerfMetrics {
    if (this.frameTimes.length === 0) {
      return {
        fps: 60,
        p95FrameMs: 16.6,
        visibleBuildings: this.visibleBuildings,
        totalBuildings: this.totalBuildingCount || this.buildingMeshes.length,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
      };
    }
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      fps: Math.round(1000 / Math.max(1, avg)),
      p95FrameMs: Number(p95.toFixed(1)),
      visibleBuildings: this.visibleBuildings,
      totalBuildings: this.totalBuildingCount || this.buildingMeshes.length,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
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
    this.syncPhysicalMirrorMaterials(false, false);
    this.groundMesh.geometry.dispose();
    (this.groundMesh.material as THREE.Material).dispose();
    this.disposeGroup(this.worldGroup);
    this.disposeGroup(this.playerRig.root);
    this.trajLineL.geometry.dispose();
    (this.trajLineL.material as THREE.Material).dispose();
    this.trajLineR.geometry.dispose();
    (this.trajLineR.material as THREE.Material).dispose();
    this.cockpitRearMat.dispose();
    this.cockpitLeftMat.dispose();
    this.cockpitRightMat.dispose();
    this.mirrorIdleMat.dispose();
    this.rearRT.dispose();
    this.sideRT.dispose();
    this.cockpitRearRT.dispose();
    this.cockpitLeftRT.dispose();
    this.cockpitRightRT.dispose();
    this.sharedTextures.forEach((t) => t.dispose());
    this.renderer.dispose();
  }
}
