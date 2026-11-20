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
  createCityEnvironmentPack,
  emitRealisticTree,
  emitRussianBuilding,
  finalizeCityEnvironmentPack,
  makeCloudySkyTexture,
  type CityEnvironmentPack,
} from "./cityBuildings";
import { CockpitDisplayController, DEFAULT_HEAD_UNIT_STATE, type HeadUnitState } from "./cockpitDisplays";
import {
  buildGostCrosswalk,
  buildGostRoadSign,
  buildGostSpeedSign,
  buildGostStreetProp,
  buildGostTrafficSignal,
  buildWorldRoadsAndSidewalks,
  createRoadMaterialPack,
  finalizeRoadMaterialPack,
  type GostSignalVisualHandle,
  type RoadMaterialPack,
} from "./roadInfra";
import { makeGostBayStencilTexture, makeUrbanGrassTexture } from "./roadTextures";
import { SpatialChunkBatcher, type WorldChunkHandle } from "./staticBatcher";
import {
  buildDetailedCar,
  buildDetailedPedestrian,
  disposeSharedVehicleTextures,
  makeInstrumentClusterTexture,
  makeRussianLicensePlateTexture,
  SHIFTER_LAYOUT,
  type CockpitControlId,
  type DetailedCarRig,
  type DetailedPedestrianVisual,
  type ShifterHitId,
} from "./vehiclesAndPeds";
import { cockpitFramingFor, type CockpitFraming } from "./cockpitFraming";
import { dampedHeadStep, HEAD_TURN, detentYawRad } from "./headLook";
import { SHIFT_LOCK_MIN_BRAKE } from "../sim/controls";
import type {
  CameraMode,
  ObstacleBox,
  ParkedModelKey,
  ParkingBay,
  QualityPreset,
  SimState,
  WorldData,
} from "../sim/types";
import { getPlayerCar } from "../sim/playerCar";
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
  private readonly roadChunks: WorldChunkHandle[] = [];
  private readonly detailChunks: WorldChunkHandle[] = [];
  private readonly worldPoolMaterials: THREE.Material[] = [];
  private readonly worldPoolTextures: THREE.Texture[] = [];
  private readonly worldPoolGeometries: THREE.BufferGeometry[] = [];
  private readonly signalVisuals: SignalVisual[] = [];
  private readonly pedVisuals: PedestrianVisual[] = [];
  private readonly parkedCarRoots: THREE.Object3D[] = [];
  private readonly checkpointMeshes: Array<{ id: string; mesh: THREE.Object3D }> = [];
  private readonly bayVisuals: BayVisual[] = [];
  private readonly cockpitDisplays: CockpitDisplayController;
  private readonly envMapRT: THREE.WebGLRenderTarget | null = null;
  private playerRig: CarRig;
  /** Машина, под которую собран риг игрока (для пересборки при смене в сценарии). */
  private playerRigCarId: ParkedModelKey = "ceed";
  private isLargeWorld = false;
  private totalBuildings = 0;
  private shadowDirty = true;
  private lastShadowX = Number.NaN;
  private lastShadowZ = Number.NaN;
  private lastShadowH = Number.NaN;

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
  // Отдельные GPU-буферы физических 3D-зеркал для вида из салона (без CPU readback, прямое наложение текстуры)
  private readonly cockpitRearRT: THREE.WebGLRenderTarget;
  private readonly cockpitLeftRT: THREE.WebGLRenderTarget;
  private readonly cockpitRightRT: THREE.WebGLRenderTarget;
  private readonly cockpitRearMat: THREE.MeshBasicMaterial;
  private readonly cockpitLeftMat: THREE.MeshBasicMaterial;
  private readonly cockpitRightMat: THREE.MeshBasicMaterial;
  private readonly mirrorIdleMat: THREE.Material;
  private cockpitRearPrimed = false;
  private cockpitSidePrimed = false;
  // У каждого canvas собственный кадр нужной высоты: остатки 160 строк бокового кадра
  // никогда не попадают в заднее зеркало (96 строк). Буферы переиспользуются, без аллокаций на кадр.
  private readonly mirrorFrames = new WeakMap<HTMLCanvasElement, { ctx: CanvasRenderingContext2D; image: ImageData }>();
  private readonly mirrorLookTarget = new THREE.Vector3();
  private readonly cockpitEyeWorld = new THREE.Vector3();
  private readonly cockpitLookWorld = new THREE.Vector3();
  /**
   * Three.js рендерит в offscreen-таргет в линейном пространстве и без tone mapping
   * (WebGLRenderer отключает ACES для render target). Без этой конверсии readback
   * зеркала выглядит затемнённым и «тонированным», поэтому применяем linear → sRGB.
   */
  private readonly srgbLut: Uint8Array;
  private frameCounter = 0;
  private qualityPreset: QualityPreset = "high";

  // Управление орбитальной камерой (внешние виды) и обзором головы водителя (салон)
  private orbitYaw = 0;
  private orbitPitch = 0.36;
  private orbitDist = 9.2;
  private cockpitFov = 68;
  /** Кадрировка вида из салона для текущей машины (создаётся под учебный Ceed, меняется при смене машины). */
  private cockpitFraming: CockpitFraming = cockpitFramingFor("ceed");
  /**
   * Взгляд водителя в салоне — независимое от орбиты состояние. `headYawTarget`/`headPitchTarget`
   * задают, куда водитель поворачивает голову (детент зеркала/дороги или свободный обзор ПКМ),
   * а `headYaw`/`headPitch` догоняют их с инерцией шеи. Отделение от `orbitYaw` — принципиальное:
   * раньше голова и внешняя камера делили одну переменную, поэтому переключение вида
   * (`1/2/3/4/C`) «сбивало» взгляд, а поворот головы уводил орбиту вокруг машины.
   */
  private headYaw = 0;
  private headYawTarget = 0;
  private headPitch = 0;
  private headPitchTarget = 0;
  /** Текущий детент внимания: 0 — дорога (+ салонное зеркало), +1 — левое зеркало, −1 — правое. */
  private headDetent: -1 | 0 | 1 = 0;

  private lastCameraMode: CameraMode = "chase";
  private camLookTarget = new THREE.Vector3();

  // Интерактивный 3D-рычаг 6АКПП Shiftronic в салоне (без аллокаций в кадре)
  private readonly shifterRaycaster = new THREE.Raycaster();
  private readonly shifterNdc = new THREE.Vector2();
  private readonly shifterInvChassis = new THREE.Matrix4();
  private readonly shifterLocalRay = new THREE.Ray();
  private readonly shifterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SHIFTER_LAYOUT.knobPlaneY);
  private readonly shifterLocalHit = new THREE.Vector3();
  private readonly shifterProjTmp = new THREE.Vector3();
  private shifterHover: ShifterHitId | null = null;
  private shifterDragging = false;
  private shifterManualPulse: -1 | 0 | 1 = 0;

  // Интерактивные органы салона (7" ШГУ, VOL/TUNE, аварийка, START/STOP, свет, подрулевой, ручник)
  private cockpitControlHover: CockpitControlId | null = null;
  private controlPressAnim: Partial<Record<CockpitControlId, number>> = {};
  private headUnit: HeadUnitState = DEFAULT_HEAD_UNIT_STATE;
  private savedHeadBeforeShifter: { yaw: number; pitch: number; fov: number } | null = null;
  /** Время предыдущего шага инерции шеи (мс) — для расчёта реального dt кадра. */
  private lastHeadStepAt = 0;

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
    // Управляемое обновление карты теней: пересчитывается при движении/смене мира, без лишних проходов в покое
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    // На программном WebGL (SwiftShader/llvmpipe на старых ПК и в headless CI) отключаем кубическую развёртку неба
    // и IBL-карту PMREM — экономим сотни мс CPU-растеризации на кадр; на любом реальном GPU работает 360°-небо + PBR IBL
    let isSoftwareGl = false;
    try {
      const gl = this.renderer.getContext();
      const baseRenderer = String(gl.getParameter(gl.RENDERER) ?? "");
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const unmasked = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "") : "";
      isSoftwareGl = /swiftshader|subzero|llvmpipe|softpipe|software/i.test(`${baseRenderer} ${unmasked}`);
    } catch {
      isSoftwareGl = false;
    }

    const skyTex = makeCloudySkyTexture(!isSoftwareGl);
    const shadowTex = makeContactShadowTexture();
    const learnerTex = makeLearnerSignTexture();
    const grassTex = makeUrbanGrassTexture();
    const playerPlateTex = makeRussianLicensePlateTexture("У 077 КС");
    const civilPlateTex = makeRussianLicensePlateTexture("А 482 МН");
    const clusterTex = makeInstrumentClusterTexture();
    this.cockpitDisplays = new CockpitDisplayController();
    grassTex.repeat.set(160, 160);
    // Индексы sharedTextures: 0 sky, 1 shadow, 2 learner, 3 grass, 4 playerPlate, 5 civilPlate, 6 cluster
    this.sharedTextures.push(skyTex, shadowTex, learnerTex, grassTex, playerPlateTex, civilPlateTex, clusterTex);
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog(0xc6dbed, 80, 235);

    if (!isSoftwareGl) {
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.envMapRT = pmrem.fromEquirectangular(skyTex);
        this.scene.environment = this.envMapRT.texture;
        this.scene.environmentIntensity = 0.56;
        pmrem.dispose();
      } catch {
        this.envMapRT = null;
      }
    }

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

    // Детализированный автомобиль игрока (лак clearcoat, ДХО, живой салон Supervision, 7" ШГУ + R-камера, 3D-зеркала).
    // Модель по умолчанию — учебный Ceed JD; сценарий может пересобрать риг под другую машину парка.
    this.playerRig = this.buildPlayerRigWith("ceed");
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
    this.rearCam = new THREE.PerspectiveCamera(38, 320 / 96, 0.06, 112);
    this.rearBuf = new Uint8Array(320 * 96 * 4);
    this.sideRT = new THREE.WebGLRenderTarget(320, 160, { depthBuffer: true });
    this.sideCam = new THREE.PerspectiveCamera(44, 320 / 160, 0.06, 105);
    this.sideBuf = new Uint8Array(320 * 160 * 4);
    this.sideCam.layers.enable(PLAYER_EXTERIOR_LAYER);

    // Физические 3D-зеркала в салоне: повышенное разрешение, прямой GPU-рендер и единый ACES tone mapping со сценой
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

  /**
   * Свободный обзор правой кнопкой мыши.
   * В салоне двигает голову водителя (плавно, с инерцией, и НЕ возвращает её назад после отпускания —
   * «как повернул, так и смотришь»; к детенту дороги возвращает только стрелка). Снаружи — орбиту.
   */
  adjustOrbit(deltaX: number, deltaY: number): void {
    if (this.lastCameraMode === "cockpit") {
      // 0,0042 рад/пиксель ≈ 0,24°/пиксель: полный обзор ±95° за ~400 px, без «дёрганья»
      this.headDetent = 0;
      this.headYawTarget = clamp(this.headYawTarget - deltaX * 0.0042, -HEAD_TURN.maxRad, HEAD_TURN.maxRad);
      this.headPitchTarget = clamp(this.headPitchTarget - deltaY * 0.0032, HEAD_TURN.minPitchRad, HEAD_TURN.maxPitchRad);
      return;
    }
    this.savedHeadBeforeShifter = null;
    this.orbitYaw -= deltaX * 0.0065;
    this.orbitPitch = clamp(this.orbitPitch + deltaY * 0.005, 0.12, 1.42);
  }

  /** Индекс детента внимания: −1 правое зеркало, 0 дорога, +1 левое зеркало. */
  /**
   * Переключает кадрировку салона при смене машины игрока в сценарии: поза глаз, наклон и FOV
   * пересчитываются по паспорту (T39), пользовательский зум колесом сохраняется как смещение.
   */
  setPlayerCarFraming(carId: string | null | undefined): void {
    this.cockpitFraming = cockpitFramingFor(carId);
    // Базовый FOV возвращаем к паспортному: кадр машины не должен наследовать зум предыдущей
    this.cockpitFov = this.cockpitFraming.fovDeg;
    this.camera.fov = this.cockpitFov;
    this.camera.updateProjectionMatrix();
  }

  /** Текущая кадрировка салона (для отладки и смоук-тестов). */
  getCockpitFraming(): CockpitFraming {
    return this.cockpitFraming;
  }

  getHeadDetent(): -1 | 0 | 1 {
    return this.headDetent;
  }

  /** Текущий угол головы в градусах (фактический, с учётом инерции). */
  getHeadYawDeg(): number {
    return (this.headYaw * 180) / Math.PI;
  }

  /**
   * Переключение точки внимания стрелками ←/→: шаг по детентам «левое зеркало → дорога → правое зеркало».
   * Возвращает новый детент. Довод идёт с инерцией в кадре, поэтому глаз «доезжает» за ~0,18 с.
   */
  stepHeadDetent(dir: -1 | 1): -1 | 0 | 1 {
    const next = clamp(this.headDetent + dir, -1, 1) as -1 | 0 | 1;
    this.setHeadDetent(next);
    return next;
  }

  /** Прямая установка детента (клик по кнопке, клавиша ↓ — «дорога»). */
  setHeadDetent(detent: -1 | 0 | 1): void {
    this.headDetent = detent;
    this.headYawTarget = detentYawRad(detent);
    this.headPitchTarget = 0;
    this.savedHeadBeforeShifter = null;
  }

  /** Мгновенно вернуть взгляд на дорогу (сброс попытки, переключение сценария, выход из салона). */
  resetHeadLook(): void {
    this.headDetent = 0;
    this.headYaw = 0;
    this.headYawTarget = 0;
    this.headPitch = 0;
    this.headPitchTarget = 0;
  }

  /**
   * Инерция шеи: цель детента или свободного обзора догоняется экспоненциально (τ ≈ 0,055 с),
   * поэтому даже мгновенный клик стрелкой выглядит как живой поворот головы, а не телепорт.
   */
  private stepHeadInertia(dt: number): void {
    // Инерция шеи — по РЕАЛЬНОМУ времени кадра, а не по фиксированным 1/60: на медленной машине
    // (или в headless без GPU) голова доводится за те же ~0,18 с, а не за 0,18 с × N кадров.
    this.headYaw = dampedHeadStep(this.headYaw, this.headYawTarget, dt, HEAD_TURN.TAU_S);
    this.headPitch = dampedHeadStep(this.headPitch, this.headPitchTarget, dt, HEAD_TURN.TAU_S);
  }

  adjustZoom(wheelDelta: number): void {
    if (this.lastCameraMode === "cockpit") {
      // В салоне колесо мыши плавно регулирует угол обзора (50° крупно — 88° панорамно со всеми 3 зеркалами)
      this.cockpitFov = clamp(this.cockpitFov + wheelDelta * 0.03, 50, 88);
      return;
    }
    this.orbitDist = clamp(this.orbitDist * (1 + wheelDelta * 0.0009), 4.6, 42);
  }

  resetOrbit(): void {
    this.savedHeadBeforeShifter = null;
    this.orbitYaw = 0;
    this.orbitPitch = 0.36;
    this.orbitDist = 9.2;
    // Сброс возвращает паспортный FOV текущей машины, а не общий 68°
    this.cockpitFov = this.cockpitFraming.fovDeg;
    this.resetHeadLook();
  }

  /** Быстрый перевод взгляда водителя в салоне на 3D-рычаг 6АКПП Shiftronic и обратно на дорогу (клавиша G). */
  toggleCockpitShifterView(): boolean {
    if (this.isCockpitShifterView()) {
      const prev = this.savedHeadBeforeShifter;
      this.savedHeadBeforeShifter = null;
      // Возвращаемся туда, куда смотрел водитель до взгляда на рычаг (детент или свободный обзор)
      this.headYawTarget = prev ? prev.yaw : detentYawRad(this.headDetent);
      this.headPitchTarget = prev ? prev.pitch : 0;
      this.cockpitFov = prev ? prev.fov : 68;
      return false;
    }
    this.savedHeadBeforeShifter = { yaw: this.headYawTarget, pitch: this.headPitchTarget, fov: this.cockpitFov };
    // Взгляд вниз-вправо на консоль: цель головы, а не орбиты — после возврата взгляд восстанавливается
    this.headYawTarget = -HEAD_TURN.SHIFTER_RAD;
    this.headPitchTarget = -HEAD_TURN.SHIFTER_PITCH_RAD;
    this.cockpitFov = 62;
    return true;
  }

  /** Смотрит ли сейчас камера салона вниз-вправо на консоль рычага АКПП. */
  isCockpitShifterView(): boolean {
    return this.headPitchTarget < -0.5 && this.headYawTarget < -0.4;
  }

  /** Сохраняет состояние 7" ШГУ (режим, станция, клип, промо-слот) для 3D-экрана и подсветки. */
  setHeadUnitState(headUnit: HeadUnitState): void {
    this.headUnit = headUnit;
  }

  /** Возвращает текущее состояние ШГУ, которым управляет 3D-сцена (для UI и тестов). */
  getHeadUnitState(): HeadUnitState {
    return this.headUnit;
  }

  /** Подсветка наведения на интерактивный орган салона и короткий импульс нажатия. */
  setCockpitControlInteraction(hovered: CockpitControlId | null, pressed: CockpitControlId | null = null): void {
    this.cockpitControlHover = hovered;
    if (pressed) this.controlPressAnim[pressed] = 1;
  }

  /**
   * Проверяет попадание курсора (`[0..1]`) в органы салона: 7" ШГУ, шайбы VOL/TUNE, аварийка,
   * ENGINE START/STOP, переключатель света, левый подрулевой и ручник. Только в камере `cockpit`.
   */
  pickCockpitControl(normX: number, normY: number): CockpitControlId | null {
    if (this.lastCameraMode !== "cockpit") return null;
    const targets = this.playerRig.cockpitPickTargets;
    if (!targets || targets.length === 0) return null;
    this.playerRig.chassis.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.shifterNdc.set(normX * 2 - 1, -(normY * 2 - 1));
    this.shifterRaycaster.setFromCamera(this.shifterNdc, this.camera);
    const hits = this.shifterRaycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.cockpitControl as CockpitControlId | undefined) ?? null;
  }

  /** Нормализованные экранные координаты `[0..1]` органа салона (для якоря подсказки). */
  getCockpitControlScreenPoint(id: CockpitControlId): { normX: number; normY: number } | null {
    if (this.lastCameraMode !== "cockpit") return null;
    const targets = this.playerRig.cockpitPickTargets;
    if (!targets) return null;
    const obj = targets.find((t) => t.userData.cockpitControl === id);
    if (!obj) return null;
    this.playerRig.chassis.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    obj.getWorldPosition(this.shifterProjTmp);
    this.shifterProjTmp.project(this.camera);
    if (this.shifterProjTmp.z < -1 || this.shifterProjTmp.z > 1) return null;
    const normX = (this.shifterProjTmp.x + 1) * 0.5;
    const normY = (1 - this.shifterProjTmp.y) * 0.5;
    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return null;
    return { normX, normY };
  }

  /** Переводит взгляд водителя в салоне на центральную консоль с 7" ШГУ (клик по экрану в HUD). */
  lookAtHeadUnit(): boolean {
    if (this.lastCameraMode !== "cockpit") return false;
    // Центральная консоль с 7" ШГУ — ниже и правее глаз водителя: взгляд вниз-вправо, но выше кулисы АКПП.
    // Запоминаем детент/свободный обзор, чтобы после возврата взгляд встал обратно на дорогу или зеркало.
    this.savedHeadBeforeShifter = { yaw: this.headYawTarget, pitch: this.headPitchTarget, fov: this.cockpitFov };
    this.headYawTarget = -0.62;
    this.headPitchTarget = -0.34;
    this.cockpitFov = 66;
    return true;
  }

  /** Обновляет подсветку наведения/захвата и пружинный ход `+/−` 3D-рычага АКПП. */
  setShifterInteraction(hovered: ShifterHitId | null, dragging: boolean, manualPulse: -1 | 0 | 1 = 0): void {
    this.shifterHover = hovered;
    this.shifterDragging = dragging;
    this.shifterManualPulse = manualPulse;
  }

  /**
   * Проверяет попадание курсора (нормализованные координаты холста `[0..1]`) в 3D-рычаг АКПП или пазы кулисы.
   * Вызывается только в режиме камеры `cockpit` по компактному списку из 8 коллайдеров (< 0,02 мс).
   */
  pickCockpitShifter(normX: number, normY: number): ShifterHitId | null {
    if (this.lastCameraMode !== "cockpit") return null;
    const targets = this.playerRig.shifterPickTargets;
    if (!targets || targets.length === 0) return null;
    this.playerRig.chassis.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.shifterNdc.set(normX * 2 - 1, -(normY * 2 - 1));
    this.shifterRaycaster.setFromCamera(this.shifterNdc, this.camera);
    // Сначала проверяем рукоятку рычага — захват за набалдашник всегда имеет приоритет над плоской кулисой
    const knobHits = this.shifterRaycaster.intersectObject(targets[0], false);
    if (knobHits.length > 0) return "lever";
    const slotHits = this.shifterRaycaster.intersectObjects(targets.slice(1), false);
    if (slotHits.length > 0) {
      return (slotHits[0].object.userData.shifterHit as ShifterHitId | undefined) ?? null;
    }
    return null;
  }

  /** Проецирует луч курсора (`[0..1]`) на горизонтальную плоскость хода 3D-рычага АКПП в локальных координатах кузова. */
  projectToShifterLocal(normX: number, normY: number): { x: number; z: number } | null {
    if (this.lastCameraMode !== "cockpit") return null;
    this.playerRig.chassis.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.shifterNdc.set(normX * 2 - 1, -(normY * 2 - 1));
    this.shifterRaycaster.setFromCamera(this.shifterNdc, this.camera);
    this.shifterInvChassis.copy(this.playerRig.chassis.matrixWorld).invert();
    this.shifterLocalRay.copy(this.shifterRaycaster.ray).applyMatrix4(this.shifterInvChassis);
    const hit = this.shifterLocalRay.intersectPlane(this.shifterPlane, this.shifterLocalHit);
    if (!hit) return null;
    return { x: hit.x, z: hit.z };
  }

  /** Возвращает текущее локальное положение основания 3D-рычага АКПП `(x, z)` и центр кулисы `gateZ`. */
  getShifterLocalAnchor(): { leverX: number; leverZ: number; gateZ: number } {
    const gateZ = (CAR.frontOverhang - CAR.rearOverhang) * 0.5 + SHIFTER_LAYOUT.gateOffsetZ;
    const piv = this.playerRig.gearLeverPivot;
    return {
      leverX: piv ? piv.position.x : SHIFTER_LAYOUT.mainRailX,
      leverZ: piv ? piv.position.z : gateZ + SHIFTER_LAYOUT.offP,
      gateZ,
    };
  }

  /** Возвращает нормализованные экранные координаты `[0..1]` рукоятки или паза 3D-селектора в режиме `cockpit`. */
  getShifterTargetScreenPoint(id: ShifterHitId): { normX: number; normY: number } | null {
    if (this.lastCameraMode !== "cockpit") return null;
    const targets = this.playerRig.shifterPickTargets;
    if (!targets) return null;
    const obj = targets.find((t) => t.userData.shifterHit === id);
    if (!obj) return null;
    this.playerRig.chassis.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    obj.getWorldPosition(this.shifterProjTmp);
    this.shifterProjTmp.project(this.camera);
    if (this.shifterProjTmp.z < -1 || this.shifterProjTmp.z > 1) return null;
    const normX = (this.shifterProjTmp.x + 1) * 0.5;
    const normY = (1 - this.shifterProjTmp.y) * 0.5;
    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return null;
    return { normX, normY };
  }

  applyQuality(preset: QualityPreset): void {
    this.qualityPreset = preset;
    if (preset === "low") {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.scene.environment = null;
    } else if (preset === "medium") {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.shadowMap.enabled = true;
      this.sun.shadow.mapSize.set(1024, 1024);
      this.scene.environment = this.envMapRT?.texture ?? null;
    } else {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      const sz = this.isLargeWorld ? 1024 : 2048;
      this.sun.shadow.mapSize.set(sz, sz);
      this.scene.environment = this.envMapRT?.texture ?? null;
    }
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.shadowDirty = true;
  }

  // === [SEC:render-world] Построение 3D-мира сценария, препятствий и светофоров ===
  /** Перестраивает 3D-геометрию мира при смене сценария или размеров бокса, освобождая старые ресурсы. */
  loadWorld(world: WorldData): void {
    this.clearWorldResources();
    this.roadChunks.length = 0;
    this.detailChunks.length = 0;
    this.signalVisuals.length = 0;
    this.pedVisuals.length = 0;
    this.parkedCarRoots.length = 0;
    this.checkpointMeshes.length = 0;
    this.bayVisuals.length = 0;
    this.totalBuildings = 0;
    this.shadowDirty = true;
    this.lastShadowX = Number.NaN;
    this.lastShadowZ = Number.NaN;
    this.lastShadowH = Number.NaN;
    this.cockpitRearPrimed = false;
    this.cockpitSidePrimed = false;

    // Подгоняем травяную подложку, карту теней и дальность камеры под реальные размеры карты (вплоть до 6×6 км)
    const spanX = Math.max(120, world.bounds.maxX - world.bounds.minX);
    const spanZ = Math.max(120, world.bounds.maxZ - world.bounds.minZ);
    const maxSpan = Math.max(spanX, spanZ);
    this.isLargeWorld = maxSpan > 380 || world.obstacles.length > 180 || world.roads.length > 40;
    if (this.qualityPreset === "high") {
      const targetMapSize = this.isLargeWorld ? 1024 : 2048;
      if (this.sun.shadow.mapSize.x !== targetMapSize) {
        this.sun.shadow.mapSize.set(targetMapSize, targetMapSize);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
    }
    const midX = (world.bounds.minX + world.bounds.maxX) * 0.5;
    const midZ = (world.bounds.minZ + world.bounds.maxZ) * 0.5;
    this.groundMesh.position.set(midX, -0.02, midZ);
    this.groundMesh.scale.set(Math.max(1400, spanX + 900), Math.max(1400, spanZ + 900), 1);

    const targetFar = maxSpan > 340 ? Math.min(1100, Math.max(480, maxSpan * 0.65)) : 420;
    if (this.camera.far !== targetFar) {
      this.camera.far = targetFar;
      this.camera.updateProjectionMatrix();
    }
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = maxSpan > 340 ? 115 : 80;
      this.scene.fog.far = maxSpan > 340 ? 340 : 235;
    }

    const roadMats = createRoadMaterialPack();
    const cityEnv = createCityEnvironmentPack();
    // Пространственные чанки сливают десятки тысяч дорог, зданий, деревьев, заборов и знаков в считаные draw calls
    const roadChunkBatcher = new SpatialChunkBatcher(240);
    const detailChunkBatcher = new SpatialChunkBatcher(165);
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
    buildWorldRoadsAndSidewalks(roadChunkBatcher, detailChunkBatcher, world, roadMats);

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
      this.addObstacleMesh(
        obs,
        world,
        detailChunkBatcher,
        roadMats,
        cityEnv,
        shadowTex,
        learnerTex,
        civilPlateTex,
        clusterTex
      );
    }

    // Светофоры ГОСТ Р 52282 (Т.1 + Г-консоль + П.1 + табличка 6.16 «СТОП») и стоп-линии 1.12
    for (const sig of world.signals) {
      this.signalVisuals.push(buildGostTrafficSignal(detailChunkBatcher, this.worldGroup, sig, roadMats));
    }

    // Пешеходные переходы ГОСТ 1.14.1 (бело-жёлтая «зебра», тактильная плитка, знаки 5.19.1/5.19.2) и пешеходы
    world.crosswalks.forEach((cw, cwIdx) => {
      buildGostCrosswalk(detailChunkBatcher, cw, roadMats);
      const pedVis = buildDetailedPedestrian(cw.id, cwIdx, shadowTex);
      this.worldGroup.add(pedVis.group);
      this.pedVisuals.push(pedVis);
    });

    // Дорожные знаки ГОСТ Р 52290-2004 (все 12 классов, кеш текстур, фигурная подложка и ориентация sign.h)
    const renderedSignIds = new Set<string>();
    for (const sign of world.signs ?? []) {
      renderedSignIds.add(`${SIGN_SPEED_ZONE_PREFIX}${sign.id}`);
      buildGostRoadSign(detailChunkBatcher, sign, roadMats);
    }

    // Знаки ограничения скорости 3.24 (для встроенных сценариев без дублирования world.signs)
    for (const sz of world.speedZones) {
      if (renderedSignIds.has(sz.id)) continue;
      const aimH = Math.atan2(sz.x - sz.signX, sz.z - sz.signZ);
      const snappedH =
        Math.abs(Math.cos(aimH)) >= Math.abs(Math.sin(aimH))
          ? Math.cos(aimH) >= 0
            ? 0
            : Math.PI
          : Math.sin(aimH) >= 0
            ? Math.PI / 2
            : -Math.PI / 2;
      buildGostSpeedSign(detailChunkBatcher, sz.limitKmh, sz.signX, sz.signZ, snappedH, roadMats);
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
        emitRealisticTree(detailChunkBatcher, tx, tz, 4.8, cityEnv, `${world.scenarioId}-t${tIdx}`);
      });
    }

    // Сливаем статическую геометрию по чанкам (десятки тысяч примитивов -> считаные draw calls!) и регистрируем ресурсы пулов
    this.roadChunks.push(...roadChunkBatcher.flush(this.worldGroup));
    this.detailChunks.push(...detailChunkBatcher.flush(this.worldGroup));

    const roadRes = finalizeRoadMaterialPack(roadMats);
    const cityRes = finalizeCityEnvironmentPack(cityEnv);
    this.worldPoolMaterials.push(...roadRes.materials, ...cityRes.materials);
    this.worldPoolTextures.push(...roadRes.textures, ...cityRes.textures);
    this.worldPoolGeometries.push(...roadRes.geometries);

    this.resetOrbit();
    this.camLookTarget.set(world.start.x, 1.0, world.start.z);
  }

  private addObstacleMesh(
    obs: ObstacleBox,
    world: WorldData,
    detailChunks: SpatialChunkBatcher,
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
      this.parkedCarRoots.push(rig.root);
      return;
    }

    if (buildGostStreetProp(detailChunks, obs, world, roadMats)) {
      return;
    }

    if (obs.kind === "building") {
      emitRussianBuilding(detailChunks, obs, cityEnv);
      this.totalBuildings++;
      return;
    }

    if (obs.kind === "tree") {
      emitRealisticTree(detailChunks, obs.cx, obs.cz, Math.max(3.4, obs.height), cityEnv, obs.id);
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
    if (rig.driverGroup) rig.driverGroup.visible = opts.cameraMode !== "cockpit";

    // Поворотники (период 700 мс, как в v8)
    const { blinkOn, leftLit, rightLit } = getTurnSignalFlash(state.signal, state.time);
    for (const m of rig.blinkLeftMats) m.color.setHex(leftLit ? 0xffb020 : 0x9a621e);
    for (const m of rig.blinkRightMats) m.color.setHex(rightLit ? 0xffb020 : 0x9a621e);

    const lightsActive = state.lights && state.engineOn;
    rig.brakeMat.color.setHex(isBraking || state.handbrake ? 0xff2a2a : lightsActive ? 0xb91c1c : 0x6b1515);
    rig.reverseMat.color.setHex(state.gear === "R" && state.engineOn ? 0xf8fafc : 0x334155);
    rig.headlightMat.color.setHex(lightsActive ? 0xfffbeb : 0x94a3b8);
    if (rig.drlMat) rig.drlMat.color.setHex(state.engineOn ? 0xf0f9ff : 0x64748b);
    if (rig.plateLightMat) rig.plateLightMat.color.setHex(lightsActive ? 0xfef9c3 : 0x334155);
    if (rig.headlightBeamGroup) rig.headlightBeamGroup.visible = lightsActive;
    if (rig.headSpotL && rig.headSpotR) {
      const inten = lightsActive ? 2.1 : 0;
      rig.headSpotL.intensity = inten;
      rig.headSpotR.intensity = inten;
    }

    // Живые органы управления и 3D-дисплеи салона Kia Ceed JD (6-ст. Shiftronic, ручник, подрулевой, педали, Supervision, ШГУ)
    if (rig.gearLeverPivot) {
      const gateBaseZ = (CAR.frontOverhang - CAR.rearOverhang) * 0.5 + SHIFTER_LAYOUT.gateOffsetZ;
      const inManualGate =
        state.gear === "1" ||
        state.gear === "2" ||
        state.gear === "3" ||
        state.gear === "4" ||
        state.gear === "5" ||
        state.gear === "6";
      const dragPulse = inManualGate ? this.shifterManualPulse * 0.022 : 0;
      const shiftPulse =
        inManualGate && dragPulse === 0 && state.shiftTimer > 0 ? 0.015 : dragPulse;
      const gOff =
        state.gear === "P"
          ? SHIFTER_LAYOUT.offP
          : state.gear === "R"
            ? SHIFTER_LAYOUT.offR
            : state.gear === "N"
              ? SHIFTER_LAYOUT.offN
              : SHIFTER_LAYOUT.offD + shiftPulse;
      rig.gearLeverPivot.position.x = inManualGate
        ? SHIFTER_LAYOUT.manualRailX
        : SHIFTER_LAYOUT.mainRailX;
      rig.gearLeverPivot.position.z = gateBaseZ + gOff;
      // Лёгкий реалистичный наклон штока вдоль хода кулисы и в сторону паза Shiftronic
      rig.gearLeverPivot.rotation.x = clamp((gOff + 0.004) * 1.45, -0.14, 0.14);
      rig.gearLeverPivot.rotation.z = inManualGate ? -0.09 : 0;
      if (rig.gearGateDot) {
        rig.gearGateDot.position.x = inManualGate
          ? SHIFTER_LAYOUT.manualDotX
          : SHIFTER_LAYOUT.mainDotX;
        rig.gearGateDot.position.z = gateBaseZ + gOff;
      }
      if (rig.gearGateDotMat) {
        rig.gearGateDotMat.color.setHex(
          state.gear === "R"
            ? 0xff5a5a
            : state.gear === "D"
              ? 0x52d6bd
              : inManualGate
                ? 0xf5b942
                : 0xe2e8f0
        );
      }
      // Тактильная подсветка набалдашника и рамки кулисы при наведении/захвате мышью в салоне
      const activeGlow = opts.cameraMode === "cockpit" && (this.shifterDragging || this.shifterHover !== null);
      if (rig.gearKnobCapMat) {
        rig.gearKnobCapMat.emissive.setHex(this.shifterDragging ? 0xf5b942 : activeGlow ? 0x52d6bd : 0x000000);
        rig.gearKnobCapMat.emissiveIntensity = this.shifterDragging ? 0.55 : activeGlow ? 0.34 : 0;
      }
      if (rig.gearGateRimMat) {
        rig.gearGateRimMat.emissive.setHex(this.shifterDragging ? 0xf5b942 : activeGlow ? 0x52d6bd : 0x000000);
        rig.gearGateRimMat.emissiveIntensity = this.shifterDragging ? 0.32 : activeGlow ? 0.2 : 0;
      }
    }
    if (rig.handbrakePivot) {
      rig.handbrakePivot.rotation.x = state.handbrake ? -0.44 : -0.05;
    }
    if (rig.leftStalkPivot) {
      // Как на реальном Kia Ceed JD: левый поворотник Q — рычажок вниз (-Y), правый E — вверх (+Y)
      rig.leftStalkPivot.rotation.z = state.signal === "left" ? -0.17 : state.signal === "right" ? 0.17 : 0;
    }
    if (rig.hazardBtnMat) {
      rig.hazardBtnMat.color.setHex(state.signal === "hazard" && blinkOn ? 0xff2e2e : 0x8a1c1c);
    }
    if (rig.startBtnMat) {
      rig.startBtnMat.color.setHex(state.engineOn ? 0x22c55e : 0xd97706);
    }
    if (rig.gearGateRimMat && !this.shifterDragging && this.shifterHover === null) {
      // Shift Lock «как в жизни»: рамка кулисы и набалдашник предупреждают, что селектор заперт без тормоза
      const lockedInP = state.engineOn && state.gear === "P" && (state.brakePos ?? 0) < SHIFT_LOCK_MIN_BRAKE;
      const deadSelector = !state.engineOn;
      if (lockedInP || deadSelector) {
        rig.gearGateRimMat.emissive.setHex(0xf5b942);
        rig.gearGateRimMat.emissiveIntensity = 0.22;
        if (rig.gearKnobCapMat) {
          rig.gearKnobCapMat.emissive.setHex(0xf5b942);
          rig.gearKnobCapMat.emissiveIntensity = 0.16;
        }
      }
    }
    if (rig.brakePedalPivot) {
      rig.brakePedalPivot.rotation.x = isBraking ? -0.22 : 0;
    }
    if (rig.gasPedalPivot) {
      const throttleFrac = state.engineOn && !isBraking ? clamp(state.throttlePos, 0, 1) : 0;
      rig.gasPedalPivot.rotation.x = -throttleFrac * 0.24;
    }
    if (rig.seatbeltStrap) {
      rig.seatbeltStrap.visible = state.belt;
    }

    // Оживление органов салона: нажатия в 3D (ШГУ, VOL/TUNE, свет, START/STOP) и медиафаза экрана
    const dtSec = Math.min(0.1, Math.max(0, dtMs) / 1000);
    for (const key of Object.keys(this.controlPressAnim) as CockpitControlId[]) {
      const v = this.controlPressAnim[key] ?? 0;
      if (v <= 0) delete this.controlPressAnim[key];
      else this.controlPressAnim[key] = Math.max(0, v - dtSec * 2.6);
    }
    const pressOf = (id: CockpitControlId) => this.controlPressAnim[id] ?? 0;
    const knobL = rig.headUnitKnobL;
    const knobR = rig.headUnitKnobR;
    if (knobL) {
      // Шайба VOL: плавный доворот при каждом клике (импульс) и подсветка наведения
      const volTurn = this.headUnit.stationIndex * 0.42 + pressOf("vol") * 0.9;
      knobL.rotation.y = volTurn;
      knobL.scale.setScalar(1 + (this.cockpitControlHover === "vol" ? 0.16 : 0) + pressOf("vol") * 0.12);
    }
    if (knobR) {
      knobR.rotation.y = (this.cockpitControlHover === "tune" ? 0.22 : 0) + pressOf("tune") * 0.6;
      knobR.scale.setScalar(1 + (this.cockpitControlHover === "tune" ? 0.16 : 0) + pressOf("tune") * 0.12);
    }
    if (rig.headlightSwitchPivot) {
      rig.headlightSwitchPivot.rotation.z = state.lights ? -0.62 - pressOf("headlight") * 0.2 : pressOf("headlight") * -0.18;
    }
    if (rig.headlightSwitchMat) {
      rig.headlightSwitchMat.color.setHex(state.lights ? 0x22c55e : this.cockpitControlHover === "headlight" ? 0x64748b : 0x334155);
    }
    if (rig.headUnitScreen) {
      const mat = rig.headUnitScreen.material as THREE.MeshBasicMaterial;
      const hover = this.cockpitControlHover === "headunit" || this.cockpitControlHover === "vol" || this.cockpitControlHover === "tune";
      mat.color.setHex(this.headUnit.mode === "off" ? 0x51606e : hover ? 0xa9d4e6 : 0xffffff);
    }
    if (rig.startBtnMat && pressOf("start") > 0) {
      rig.startBtnMat.color.setHex(0xfef08a);
    }
    if (rig.hazardBtnMat && (pressOf("hazard") > 0 || this.cockpitControlHover === "hazard")) {
      if (state.signal !== "hazard") rig.hazardBtnMat.color.setHex(0xb91c1c);
    }

    if (opts.cameraMode === "cockpit") {
      // Внутри dirty-кеш: 0 мс в покое; в движении обновляем не чаще ~20 Гц (за исключением мгновенных переключений)
      this.cockpitDisplays.update(state, world, leftLit, rightLit, this.headUnit, isBraking, now / 1000);
    }

    // Подвижная тень солнца: пересчитывается при старте и реальном смещении/повороте машины (0 лишних GPU-проходов в покое)
    if (this.renderer.shadowMap.enabled) {
      const movedSq = (state.x - this.lastShadowX) ** 2 + (state.z - this.lastShadowZ) ** 2;
      const turned = Math.abs(state.h - this.lastShadowH);
      if (this.shadowDirty || ((movedSq >= 0.16 || turned >= 0.03) && this.frameCounter % 3 === 0)) {
        this.sun.position.set(state.x + 26, 44, state.z - 20);
        this.sun.target.position.set(state.x, 0, state.z);
        this.lastShadowX = state.x;
        this.lastShadowZ = state.z;
        this.lastShadowH = state.h;
        this.shadowDirty = false;
        this.renderer.shadowMap.needsUpdate = true;
      }
    }

    // 2. Мгновенное отсечение дальних чанков (здания, деревья, заборы, разметка, знаки, дороги) — O(число чанков)
    const zoomBonus = opts.cameraMode === "top" || opts.cameraMode === "orbit" ? this.orbitDist * 1.4 : 0;
    const baseDetailR = opts.drawRadius + 30 + zoomBonus;
    const baseRoadR = opts.drawRadius + 185 + zoomBonus;
    let visBld = 0;
    for (let i = 0; i < this.detailChunks.length; i++) {
      const ch = this.detailChunks[i];
      const dx = ch.cx - state.x;
      const dz = ch.cz - state.z;
      const lim = baseDetailR + ch.radius;
      const show = dx * dx + dz * dz <= lim * lim;
      ch.group.visible = show;
      if (show) visBld += ch.buildingCount;
    }
    for (let i = 0; i < this.roadChunks.length; i++) {
      const ch = this.roadChunks[i];
      const dx = ch.cx - state.x;
      const dz = ch.cz - state.z;
      const lim = baseRoadR + ch.radius;
      ch.group.visible = dx * dx + dz * dz <= lim * lim;
    }
    this.visibleBuildings = visBld;

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

    // 4. Светофоры и пешеходы (с радиусным отсечением для крупных OSM-карт) и контрольные точки
    const sigLimitSq = (baseDetailR + 24) * (baseDetailR + 24);
    for (const sv of this.signalVisuals) {
      const sdx = sv.def.x - state.x;
      const sdz = sv.def.z - state.z;
      const visSig = sdx * sdx + sdz * sdz <= sigLimitSq;
      sv.lensGroup.visible = visSig;
      if (!visSig) continue;
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
      const pedGo = phase === "red";
      sv.pedRedMat.color.setHex(pedGo ? 0x380c0c : 0xff3b3b);
      sv.pedGreenMat.color.setHex(pedGo ? 0x22e584 : 0x08351d);
    }

    const pedLimitSq = (opts.drawRadius + 24) * (opts.drawRadius + 24);
    for (let i = 0; i < this.pedVisuals.length; i++) {
      const pv = this.pedVisuals[i];
      const cw = world.crosswalks[i];
      if (!cw) continue;
      const cdx = cw.cx - state.x;
      const cdz = cw.cz - state.z;
      const visPed = cdx * cdx + cdz * cdz <= pedLimitSq;
      pv.group.visible = visPed;
      if (!visPed) continue;
      const pose = getPedestrianPose(cw, state.time);
      pv.group.position.set(pose.x, 0, pose.z);
      pv.group.rotation.y = pose.h;
      const swing = Math.sin(pose.walkPhase) * 0.44;
      pv.legL.rotation.x = swing;
      pv.legR.rotation.x = -swing;
      pv.armL.rotation.x = -swing * 0.72;
      pv.armR.rotation.x = swing * 0.72;
    }

    const carLimitSq = (baseDetailR + 12) * (baseDetailR + 12);
    for (let i = 0; i < this.parkedCarRoots.length; i++) {
      const carObj = this.parkedCarRoots[i];
      const pdx = carObj.position.x - state.x;
      const pdz = carObj.position.z - state.z;
      carObj.visible = pdx * pdx + pdz * pdz <= carLimitSq;
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

    // 6. Камера (обновляем матрицу кузова заранее, чтобы салон и физические зеркала не дрожали относительно головы)
    const prevCameraMode = this.lastCameraMode;
    this.lastCameraMode = opts.cameraMode;
    if (prevCameraMode === "cockpit" && opts.cameraMode !== "cockpit" && this.savedHeadBeforeShifter) {
      // Взгляд «сохранён» мышью/кнопкой G — возвращаем цель головы, а не орбиту:
      // после возврата в салон (2) водитель смотрит туда же, куда смотрел до переключения вида.
      this.headYawTarget = this.savedHeadBeforeShifter.yaw;
      this.headPitchTarget = this.savedHeadBeforeShifter.pitch;
      this.cockpitFov = this.savedHeadBeforeShifter.fov;
      this.savedHeadBeforeShifter = null;
    }
    this.playerRig.chassis.updateWorldMatrix(true, false);
    // Инерция шеи: голова плавно догоняет цель (детент зеркала/дороги или свободный обзор ПКМ).
    // dt берём из реального времени кадра (ограничен 0,1 с, чтобы скачок после сворачивания вкладки
    // не «телепортировал» голову), иначе на медленном рендере довод растягивается на секунды.
    const headNow = performance.now();
    const headDt = Math.min(0.1, Math.max(0, (headNow - this.lastHeadStepAt) / 1000));
    this.lastHeadStepAt = headNow;
    this.stepHeadInertia(headDt);
    this.updateCamera(state, opts.cameraMode);

    // 7. Зеркала: в виде из салона — живое GPU-отражение прямо на физических 3D-зеркалах; снаружи — в HUD-панели.
    // При shadowMap.autoUpdate=false Three.js сам сбрасывает needsUpdate после ровно одного прохода теней на кадр
    // (включая самый первый кадр после loadWorld, так что зеркала сразу получают актуальные тени).
    this.frameCounter++;
    const inCockpit = opts.cameraMode === "cockpit";
    const inReverseCam = inCockpit && state.engineOn && state.gear === "R";
    this.syncPhysicalMirrorMaterials(inCockpit && opts.showRearMirror, inCockpit && opts.showMirrors, inReverseCam);

    const needCockpitRear = inCockpit && (opts.showRearMirror || inReverseCam);
    if (inCockpit && (needCockpitRear || opts.showMirrors)) {
      const stride = this.qualityPreset === "low" ? 4 : this.isLargeWorld ? 3 : 2;
      if (needCockpitRear && (!this.cockpitRearPrimed || this.frameCounter % stride === 0)) {
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
    } else if (!inCockpit && mirrors && (opts.showMirrors || opts.showRearMirror)) {
      const rearStride = this.isLargeWorld ? 3 : 2;
      const sideStride = this.isLargeWorld ? 4 : 3;
      if (opts.showRearMirror && mirrors.rear && this.frameCounter % rearStride === 0) {
        this.renderInto(this.rearRT, this.rearCam, this.rearBuf, 0, 1.24, 0.25, 0, -0.08, 38, mirrors.rear);
      }
      const mountX = CAR.width / 2 + 0.14;
      if (opts.showMirrors && mirrors.left && this.frameCounter % sideStride === 0) {
        this.renderInto(this.sideRT, this.sideCam, this.sideBuf, mountX, 0.92, 0.49, -0.53, -0.10, 44, mirrors.left);
      }
      if (opts.showMirrors && mirrors.right && this.frameCounter % sideStride === 1) {
        this.renderInto(this.sideRT, this.sideCam, this.sideBuf, -mountX, 0.92, 0.49, 0.53, -0.10, 44, mirrors.right);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  /** Переключает материал физических 3D-полотeн зеркал и камеры заднего вида R на 7" ШГУ. */
  private syncPhysicalMirrorMaterials(activeRear: boolean, activeSide: boolean, activeRevCam = false): void {
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
    if (rig.rearCamScreen && rig.rearCamOverlay && rig.headUnitScreen) {
      const target = activeRevCam ? this.cockpitRearMat : this.mirrorIdleMat;
      if (rig.rearCamScreen.material !== target) rig.rearCamScreen.material = target;
      rig.rearCamScreen.visible = activeRevCam;
      rig.rearCamOverlay.visible = activeRevCam;
      rig.headUnitScreen.visible = !activeRevCam;
    }
    if (!activeRear && !activeRevCam) this.cockpitRearPrimed = false;
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

  /**
   * Собирает риг машины игрока по паспорту парка и выдаёт слои так же, как при первой сборке:
   * внешние меши на `PLAYER_EXTERIOR_LAYER`, зеркальная оптика — на `OWN_MIRROR_HARDWARE_LAYER`.
   */
  private buildPlayerRigWith(carId: ParkedModelKey): CarRig {
    const spec = getPlayerCar(carId);
    const rig = buildDetailedCar(
      carId,
      spec.color,
      true,
      this.sharedTextures[1] as THREE.CanvasTexture,
      this.sharedTextures[2] as THREE.CanvasTexture,
      this.sharedTextures[4] as THREE.CanvasTexture,
      this.cockpitDisplays.clusterTex,
      OWN_MIRROR_HARDWARE_LAYER,
      {
        headUnitTex: this.cockpitDisplays.headUnitTex,
        rearOverlayTex: this.cockpitDisplays.rearOverlayTex,
      }
    );
    rig.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && !obj.layers.isEnabled(OWN_MIRROR_HARDWARE_LAYER)) {
        obj.layers.set(PLAYER_EXTERIOR_LAYER);
      }
    });
    this.playerRigCarId = carId;
    return rig;
  }

  /**
   * Пересаживает игрока в другую машину сценария: освобождает старый риг и собирает новый
   * по паспорту (габариты, база, колея, цвет). Камера салона пересчитывается тем же вызовом.
   */
  setPlayerCarModel(carId: string | null | undefined): void {
    const next = (carId ?? "ceed") as ParkedModelKey;
    if (next === this.playerRigCarId) {
      this.setPlayerCarFraming(next);
      return;
    }
    const old = this.playerRig;
    this.scene.remove(old.root);
    this.disposeGroup(old.root);
    this.playerRig = this.buildPlayerRigWith(next);
    this.scene.add(this.playerRig.root);
    this.playerRig.chassis.updateMatrixWorld(true);
    this.shadowDirty = true;
    this.setPlayerCarFraming(next);
  }

  private updateCamera(s: SimState, mode: CameraMode): void {
    const fx = Math.sin(s.h);
    const fz = Math.cos(s.h);

    if (mode === "cockpit") {
      // Водительское место слева (+X), жёстко связанное с кузовом (наклон/крен совпадают с салоном и 3D-зеркалами).
      // Поза и наклон берутся из кадрировки конкретной машины (T39), FOV — из неё же, пока игрок не крутил колесо.
      const pose = this.playerRig.chassis.matrixWorld;
      const framing = this.cockpitFraming;
      const localEyeX = framing.eyeX;
      const localEyeY = framing.eyeY;
      const localEyeZ = framing.eyeZ;
      // Взгляд берётся из собственного состояния головы: детенты зеркал/дороги (стрелки) или
      // свободный обзор ПКМ, который остаётся там, где его отпустили.
      const headYaw = this.headYaw;
      const headPitch = clamp(framing.pitchRad + this.headPitch, -0.74, 0.34);
      const cosP = Math.cos(headPitch);
      if (this.camera.fov !== this.cockpitFov) {
        this.camera.fov = this.cockpitFov;
        this.camera.updateProjectionMatrix();
      }
      this.cockpitEyeWorld.set(localEyeX, localEyeY, localEyeZ).applyMatrix4(pose);
      this.cockpitLookWorld
        .set(
          localEyeX + Math.sin(headYaw) * cosP * 18,
          localEyeY + Math.sin(headPitch) * 18,
          localEyeZ + Math.cos(headYaw) * cosP * 18
        )
        .applyMatrix4(pose);
      this.camera.position.copy(this.cockpitEyeWorld);
      this.camera.up.set(0, 1, 0).transformDirection(pose);
      this.camera.lookAt(this.cockpitLookWorld);
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
        totalBuildings: this.totalBuildings,
      };
    }
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      fps: Math.round(1000 / Math.max(1, avg)),
      p95FrameMs: Number(p95.toFixed(1)),
      visibleBuildings: this.visibleBuildings,
      totalBuildings: this.totalBuildings,
    };
  }

  private clearWorldResources(): void {
    this.disposeGroup(this.worldGroup);
    this.worldPoolGeometries.forEach((g) => g.dispose());
    this.worldPoolMaterials.forEach((m) => m.dispose());
    this.worldPoolTextures.forEach((t) => {
      if (!this.sharedTextures.includes(t)) t.dispose();
    });
    this.worldPoolGeometries.length = 0;
    this.worldPoolMaterials.length = 0;
    this.worldPoolTextures.length = 0;
  }

  private disposeGroup(group: THREE.Group): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
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
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    group.clear();
  }

  dispose(): void {
    this.syncPhysicalMirrorMaterials(false, false, false);
    this.scene.environment = null;
    this.groundMesh.geometry.dispose();
    (this.groundMesh.material as THREE.Material).dispose();
    this.clearWorldResources();
    this.disposeGroup(this.playerRig.root);
    this.cockpitDisplays.dispose();
    this.trajLineL.geometry.dispose();
    (this.trajLineL.material as THREE.Material).dispose();
    this.trajLineR.geometry.dispose();
    (this.trajLineR.material as THREE.Material).dispose();
    this.cockpitRearMat.dispose();
    this.cockpitLeftMat.dispose();
    this.cockpitRightMat.dispose();
    this.mirrorIdleMat.dispose();
    this.envMapRT?.dispose();
    this.rearRT.dispose();
    this.sideRT.dispose();
    this.cockpitRearRT.dispose();
    this.cockpitLeftRT.dispose();
    this.cockpitRightRT.dispose();
    this.sharedTextures.forEach((t) => t.dispose());
    // Общие текстуры парка (кулиса, лучи фар) живут на уровне модуля — освобождаем отдельно
    disposeSharedVehicleTextures();
    this.renderer.dispose();
  }
}
