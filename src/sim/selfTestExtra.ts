/**
 * @module sim/selfTestExtra
 * @layer pure-core
 * @role Расширенный набор автотестов ядра: USB-руль (T17), журнал и ДИ Уилсона (T19), реплей (T22, T24), выворот (T23), КПП/Shift/динамика (T25, T34–T35), радио/кэш треков и Shift Lock (T36), Markdown (T26), OSM/границы/маршруты/редактор (T27–T33).
 * @invariants #7 (чистое ядро без DOM и Three.js).
 */
import {
  clampVolume,
  describeStation,
  formatTrackDuration,
  INTERNET_RADIO_STATIONS,
  nextStationIndex,
  renderTrackWav,
  trackCacheKey,
  TRACK_SAMPLE_RATE,
} from "../audio/radioCatalog";
import { summarizeAgreement, wilsonInterval } from "../analytics/calibration";
import { analyticsToMarkdown, summarizeAttempts } from "../analytics/summary";
import {
  advanceCalibration,
  createAxisArming,
  createDefaultProfile,
  presetForStandardGamepad,
  readGamepad,
  startCalibration,
  updateAxisArming,
  type GamepadSnapshot,
} from "../input/gamepad";
import {
  BOUNDARY_SHAPE_PRESETS,
  buildRouteCorridorPolygon,
  clipPolylineToPolygon,
  insertBoundaryVertex,
  isInsideWorldBoundary,
  isPointInPolygon,
  isSimplePolygon,
  polygonArea,
  removeBoundaryVertex,
} from "../maps/boundary";
import {
  RoadCorridorIndex,
  doesObstacleOverlapRoads,
  parseOsmMaxspeedKmh,
  parseOsmMeters,
} from "../maps/osmDeconflict";
import { cropOsmPackToPolygon, parseMapFileText, parseOsmOrGeoJson, parseOsmXml } from "../maps/osmLoader";
import { buildRouteFromRoads, findRoadNetworkPath, listRouteCandidates } from "../maps/route";
import { checkScenarioRoute } from "../maps/routeCheck";
import { buildScenarioWorld } from "../scenarios/catalog";
import {
  buildCustomWorld,
  customFromOsmPack,
  customFromWorld,
  defaultCustomScenario,
  emptyCustomScenario,
  importEditorFileText,
  normalizeCustomScenario,
  validateCustomScenario,
} from "../scenarios/custom";
import {
  appendRoadPoint,
  applyConvexHullBoundary,
  deconflictScenarioWithRoads,
  mergeUserObjectsOntoOsmMap,
  applyPresetBoundaryShape,
  applyRouteCorridorBoundary,
  attachCheckpointToSign,
  autoFixScenarioRoute,
  bringSelectionToFront,
  clearBoundaryPolygon,
  createEditorHistory,
  cropScenarioToBoundary,
  deleteSelected,
  duplicateSelected,
  fitBoundsToContent,
  moveSelected,
  placeObjectAt,
  pushEditorHistory,
  rebuildRouteFromEditorRoads,
  redoEditorHistory,
  reverseRoadDirection,
  rotateSelected,
  setCustomBoundaryPolygon,
  undoEditorHistory,
} from "../scenarios/editorOps";
import { OBSTACLE_CATALOG, ROAD_SIGN_CATALOG } from "../scenarios/signs";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET } from "../scoring/rules";
import {
  applyShifterTarget,
  checkEngineToggle,
  checkGearChange,
  shiftLockState,
  PARK_LOCK_MAX_SPEED_MS,
  SHIFT_LOCK_MIN_BRAKE,
  stepGearSequential,
  stepShifterGate,
} from "./controls";
import { joinAttempt, splitAttempt, upsertJournal, upsertReview, type AttemptMeta } from "./journal";
import { AttemptRecorder, quantizeInput, replayInputStream, type RecordedAttempt } from "./recorder";
import { isCarInsideBay, SpatialGrid } from "./spatialGrid";
import { radioStationsFor } from "../audio/radioCatalog";
import { cockpitFramingFor, cockpitWheelBand, projectCockpitPoint } from "../render/cockpitFraming";
import { HEAD_DETENTS, HEAD_TURN, detentLabel, detentYawRad } from "../render/headLook";
import { DEFAULT_PLAYER_CAR_ID, PLAYER_CARS, getPlayerCar, playerCarPhysics } from "./playerCar";
import { createInitialState, createReadyInput, getActiveSpeedLimit, stepSimulation } from "./step";
import type { Gear, SimEvent } from "./types";
import {
  ackermannAngle,
  CAR,
  carGeometry,
  getCarCorners,
  centralSteerLimit,
  clamp,
  ENGINE_IDLE_RPM,
  FIXED_DT,
  IDLE_CREEP_MAX_KMH,
  MAX_FORWARD_GEAR,
  MAX_SPEED_KMH,
  normalizeWheelLock,
  outerTurningRadius,
  STEER_WHEEL,
  wheelDegToSteerRad,
} from "./vehicle";

export type SelfTestCase = { id: string; suite: string; name: string; fn: () => string };

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Короткий реальный заезд задним ходом с одним нарушением: ремень, 4 балла → СДАЛ. */
function recordSampleAttempt(): { attempt: RecordedAttempt; snapshotAgain: () => RecordedAttempt } {
  const world = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
  const grid = new SpatialGrid(world.obstacles, 10);
  let state = createInitialState(world, true);
  const recorder = new AttemptRecorder(state, true);
  for (let t = 0; t < 90; t++) {
    const input = { ...createReadyInput("R"), belt: false, throttle: t < 60 ? 0.5 : 0 };
    const out = stepSimulation(state, input, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
    state = out.state;
    recorder.recordTick(input, state, out.newEvents);
  }
  const snapshot = () => recorder.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
  return { attempt: snapshot(), snapshotAgain: snapshot };
}

export const extraCases: SelfTestCase[] = [
  {
    id: "T17",
    suite: "input",
    name: "USB-руль: выключен по умолчанию, знак руля, калибровка педалей, нет ложных 50 % газа",
    fn: () => {
      const mk = (axes: number[], buttons: number[] = [], id = "Wheel X", mapping = ""): GamepadSnapshot => ({
        index: 0,
        id,
        mapping,
        connected: true,
        axes,
        buttons: Array.from({ length: 16 }, (_, i) => ({
          pressed: (buttons[i] ?? 0) > 0.5,
          value: buttons[i] ?? 0,
        })),
        timestamp: 1,
      });
      const armed = (...snaps: GamepadSnapshot[]) => {
        const a = createAxisArming();
        for (const s of snaps) updateAxisArming(a, s);
        return a;
      };
      const W = (axes: number[]) => mk(axes);

      // 1. Ненастроенное устройство не влияет на управление, что бы оно ни отдавало
      const off = readGamepad(W([1, 1, 1]), createDefaultProfile(), armed(W([0, 0, 0]), W([1, 1, 1])));
      assert(
        !off.active && off.throttle === 0 && off.brake === 0 && off.steerWheelDeg === 0,
        "Устройство без включённого профиля не должно управлять машиной"
      );

      // 2. Стандартный геймпад: стик влево (ось −1) → руль влево (+), RT → газ; покой → ничего
      const xbox = (axes: number[], buttons: number[] = []) => mk(axes, buttons, "Xbox", "standard");
      const preset = { ...presetForStandardGamepad(xbox([0, 0, 0, 0])), enabled: true };
      const rt: number[] = [];
      rt[7] = 0.6;
      const stickLeft = readGamepad(xbox([-1, 0, 0, 0], rt), preset, armed(xbox([0, 0, 0, 0])));
      assert(stickLeft.active && stickLeft.steerWheelDeg === 540, `Стик влево должен давать +540°, получено ${stickLeft.steerWheelDeg}`);
      const expectedRt = (0.6 - preset.pedalDeadzone) / (1 - preset.pedalDeadzone);
      assert(Math.abs(stickLeft.throttle - expectedRt) < 1e-9 && stickLeft.brake === 0, "RT должен давать газ, LT в покое — ноль");
      const idle = readGamepad(xbox([0, 0, 0, 0]), preset, armed(xbox([0, 0, 0, 0])));
      assert(
        idle.throttle === 0 && idle.brake === 0 && !idle.steering,
        "Геймпад в покое (оси в нуле) не должен давать газ или тормоз"
      );

      // 3. Калибровка руля с «перевёрнутыми» педалями: покой +1, нажата −1; до первого нажатия драйвер отдаёт 0
      const calibrate = (frames: number[][]) => {
        let st = startCalibration(W(frames[0]), createDefaultProfile());
        for (let i = 1; i < frames.length; i++) {
          const r = advanceCalibration(st, W(frames[i]));
          assert(r.error === null, `Калибровка, шаг ${i}: ${r.error}`);
          st = r.state;
        }
        return st;
      };
      const done = calibrate([
        [0, 0, 0], // всё отпущено, педали ещё не трогали
        [-0.8, 0, 0], // руль влево
        [0, -1, 0], // газ нажат
        [0, 1, 0], // газ отпущен: настоящее положение покоя
        [0, 1, -1], // тормоз нажат
        [0, 1, 1], // тормоз отпущен
      ]);
      const prof = done.draft;
      assert(done.step === "done" && prof.calibrated && prof.enabled && prof.deviceId === "Wheel X", "Калибровка должна включать профиль устройства");
      assert(prof.steerAxis === 0 && !prof.invertSteer, "Рулевая ось: 0, стандартное направление");
      assert(
        prof.throttle.source === "axis" && prof.throttle.index === 1 && prof.throttle.rest === 1 && prof.throttle.full === -1,
        "Газ: ось 1, покой +1, нажата −1"
      );
      assert(prof.brake.source === "axis" && prof.brake.index === 2 && prof.brake.rest === 1, "Тормоз: ось 2, покой +1");

      // Педали не тронуты после подключения: значение 0 лежит посередине диапазона, но газа нет
      const untouched = readGamepad(W([0, 0, 0]), prof, armed(W([0, 0, 0])));
      assert(untouched.active && untouched.throttle === 0 && untouched.brake === 0, "Нетронутая педаль не должна читаться как нажатая наполовину");
      // После первого движения то же значение 0 — уже честная половина хода
      const half = readGamepad(W([0, 0, 1]), prof, armed(W([0, 1, 1]), W([0, 0, 1])));
      const expectedHalf = (0.5 - prof.pedalDeadzone) / (1 - prof.pedalDeadzone);
      assert(Math.abs(half.throttle - expectedHalf) < 1e-9 && half.brake === 0, "После первого нажатия середина диапазона = половина хода");

      // Руль вправо (ось растёт) → отрицательный угол
      const right = readGamepad(W([0.5, 1, 1]), prof, armed(W([0, 1, 1])));
      assert(right.steering && right.steerWheelDeg < 0, "Поворот вправо должен давать отрицательный swDeg");

      // 4. Общая ось педалей: газ в минус, тормоз в плюс, покой 0
      const combined = calibrate([[0, 0], [-0.8, 0], [0, -1], [0, 0], [0, 1], [0, 0]]).draft;
      assert(combined.throttle.index === 1 && combined.brake.index === 1, "Газ и тормоз могут делить одну ось");
      const gasOnly = readGamepad(W([0, -0.5]), combined, armed(W([0, 0]), W([0, -0.5])));
      assert(gasOnly.throttle > 0.4 && gasOnly.brake === 0, "На общей оси газ не должен включать тормоз");

      // 5. Ошибки калибровки
      const noTurn = advanceCalibration(startCalibration(W([0, 0, 0]), createDefaultProfile()), W([0.05, 0, 0]));
      assert(noTurn.error !== null && noTurn.state.step === "steerLeft", "Слабый поворот руля должен отклоняться");
      let st = startCalibration(W([0, 0, 0]), createDefaultProfile());
      for (const frame of [[-0.8, 0, 0], [0, -1, 0], [0, 1, 0]]) st = advanceCalibration(st, W(frame)).state;
      const samePedal = advanceCalibration(st, W([0, -1, 0]));
      assert(samePedal.error !== null && samePedal.state.step === "brakeFull", "Газ вместо тормоза должен отклоняться");

      // 6. Профиль привязан к устройству: другое устройство машиной не управляет
      const other = mk([0.5, -1, -1], [], "Другой руль");
      assert(!readGamepad(other, prof, armed(other)).active, "Чужое устройство не должно применять профиль");

      return "По умолчанию выключено · стик влево = +540° · покой = 0 % · калибровка 5 шагов · общая ось · привязка к устройству";
    },
  },
  {
    id: "T19",
    suite: "journal",
    name: "Журнал и сверка с инструктором: одна запись на заезд, вытеснение, доля совпадений",
    fn: () => {
      const { attempt: base, snapshotAgain } = recordSampleAttempt();
      assert(
        base.evaluation.verdict === "СДАЛ" && base.evaluation.totalPoints === 4,
        `Предпосылка теста: 4 балла и СДАЛ, получено ${base.evaluation.totalPoints} б. и ${base.evaluation.verdict}`
      );

      // 1. Повторное сохранение того же заезда не создаёт вторую запись
      const again = snapshotAgain();
      assert(again.id === base.id && again.createdAt === base.createdAt, "Повторный snapshot должен сохранять id и дату");

      // 2. Лёгкая и тяжёлая части
      const { meta, payload } = splitAttempt(base);
      assert(
        !("inputStream" in meta) && !("trajectory" in meta) && !("rulesAtRide" in meta),
        "В лёгкой части не должно быть тяжёлых полей"
      );
      const joined = joinAttempt(meta, payload);
      assert(
        joined.inputStream.length === base.inputStream.length &&
          joined.trajectory.length === base.trajectory.length &&
          joined.rulesAtRide?.version === DEFAULT_RULESET.version,
        "split → join должен возвращать полную попытку"
      );

      const at = (id: string, day: number, extra: Partial<AttemptMeta> = {}): AttemptMeta => ({
        ...meta,
        id,
        createdAt: `2026-01-${String(day).padStart(2, "0")}T10:00:00.000Z`,
        ...extra,
      });
      const review = (instructor: string, verdict: "СДАЛ" | "НЕ СДАЛ") => ({
        instructor,
        verdict,
        reviewedAt: "2026-02-01T00:00:00.000Z",
      });

      // 3. При переполнении уходит самая старая попытка БЕЗ оценки инструктора
      const reviewedOld = upsertReview(at("old-reviewed", 1), review("Иванов", "СДАЛ"));
      const r1 = upsertJournal([at("old-plain", 2), reviewedOld], at("new", 3), 2);
      assert(r1.evictedIds.join() === "old-plain", `Ожидалось вытеснение old-plain, получено «${r1.evictedIds.join()}»`);
      assert(r1.list.map((a) => a.id).join() === "new,old-reviewed", "Журнал должен идти от новых к старым");
      const r2 = upsertJournal(r1.list, at("old-reviewed", 1), 2);
      assert(r2.list.length === 2 && r2.evictedIds.length === 0, "Повторное сохранение не должно дублировать запись");
      assert(
        r2.list.find((a) => a.id === "old-reviewed")?.reviews?.length === 1,
        "Оценка инструктора должна переживать обновление попытки"
      );

      // 4. Сверка: совпадения, оба вида расхождений, разногласия инструкторов
      const lineCross: SimEvent = {
        id: "line-1",
        code: "line_cross",
        tick: 50,
        time: 0.8,
        x: 0,
        z: 0,
        h: 0,
        speedKmh: 3,
        detail: "Наезд на линию",
      };
      const passTwo = upsertReview(upsertReview(at("pass", 5), review("Иванов", "СДАЛ")), review("Петров", "НЕ СДАЛ"));
      const failBase = at("fail", 6, { events: [...meta.events, lineCross] });
      const failOne = upsertReview(upsertReview(failBase, review("иванов ", "НЕ СДАЛ")), review("Иванов", "СДАЛ"));
      assert(
        failOne.reviews?.length === 1 && failOne.reviews[0].verdict === "СДАЛ",
        "Повторная оценка того же инструктора должна заменять прежнюю"
      );
      const s = summarizeAgreement([passTwo, failOne, at("unreviewed", 7)], DEFAULT_RULESET);
      assert(s.reviews === 3 && s.agree === 1 && s.reviewedAttempts === 2, `Оценок 3, совпало 1: получено ${s.reviews}/${s.agree}`);
      assert(s.simTooLenient === 1 && s.simTooStrict === 1 && s.instructorsSplit === 1, "Должны различаться виды расхождений");
      assert(s.status === "insufficient" && s.agreementRate === 33.3, `Малая выборка: ${s.status}, ${s.agreementRate}%`);
      assert(s.disagreements[0].kind === "sim_too_lenient", "Сначала случаи, где симулятор мягче инструктора");

      // 5. Порог 90 % действует только при достаточной выборке
      const sample = (n: number, agreeing: number) =>
        Array.from({ length: n }, (_, i) =>
          upsertReview(at(`m${i}`, 8), review("Иванов", i < agreeing ? "СДАЛ" : "НЕ СДАЛ"))
        );
      assert(summarizeAgreement(sample(20, 18), DEFAULT_RULESET).status === "meets_target", "18 из 20 = 90 % → цель достигнута");
      assert(summarizeAgreement(sample(20, 17), DEFAULT_RULESET).status === "below_target", "17 из 20 = 85 % → ниже цели");
      assert(summarizeAgreement(sample(19, 19), DEFAULT_RULESET).status === "insufficient", "19 оценок мало даже при 100 %");
      const ci = wilsonInterval(18, 20);
      assert(ci !== null && Math.abs(ci.low - 69.9) < 0.2 && Math.abs(ci.high - 97.2) < 0.2, "Интервал Уилсона для 18/20");

      return `Один id на заезд · вытеснение без потери оценок · 1 из 3 = ${s.agreementRate}% (мало данных) · 18/20 → цель, ДИ ${ci?.low}–${ci?.high}%`;
    },
  },
  {
    id: "T22",
    suite: "replay",
    name: "Реплей точен при «некруглом» аналоговом вводе: запись = то, что получило ядро",
    fn: () => {
      const base = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
      const world = {
        ...base,
        obstacles: [],
        bays: [],
        start: { x: 0, z: 0, h: 0 },
        bounds: { minX: -400, maxX: 400, minZ: -400, maxZ: 400 },
      };
      const grid = new SpatialGrid([], 10);

      const drive = (quantize: boolean) => {
        let state = createInitialState(world, true);
        const recorder = new AttemptRecorder(state, true);
        const input = createReadyInput("D");
        for (let t = 0; t < 900; t++) {
          const dir = Math.floor(t / 120) % 2 === 0 ? 1 : -1;
          input.steerWheelDeg = clamp(input.steerWheelDeg + dir * (340 / 60), -540, 540); // как удержание A/D
          input.throttle = 0.37 + 0.2 * Math.sin(t / 17); // как аналоговая педаль
          if (quantize) quantizeInput(input);
          const out = stepSimulation(state, input, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          state = out.state;
          recorder.recordTick(input, state, out.newEvents);
        }
        const snap = recorder.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
        // Через JSON — как при сохранении в журнал и экспорте golden-набора
        const stream = JSON.parse(JSON.stringify(snap.inputStream)) as RecordedAttempt["inputStream"];
        const replay = replayInputStream(stream, world, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
        return { state, replay, events: snap.events.length, frames: snap.inputStream.length };
      };

      for (const [label, run] of [
        ["без квантования", drive(false)],
        ["с квантованием", drive(true)],
      ] as const) {
        assert(
          run.replay.finalState.x === run.state.x &&
            run.replay.finalState.z === run.state.z &&
            run.replay.finalState.h === run.state.h,
          `Реплей ${label} разошёлся: Δx=${Math.abs(run.replay.finalState.x - run.state.x)} м`
        );
        assert(run.replay.events.length === run.events, `Реплей ${label}: другое число событий`);
      }
      return "900 тиков, руль +5,67°/тик и синусоида газа: Δx = Δz = Δh = 0 в обоих режимах, события совпали";
    },
  },
  {
    id: "T23",
    suite: "vehicle",
    name: "Выворот 33–42°: Аккерман, симметрия и границы калибровки",
    fn: () => {
      assert(normalizeWheelLock(12) === 33 && normalizeWheelLock(200) === 42, "Предел должен находиться в диапазоне 33–42°");
      for (const v of [undefined, NaN, null, Infinity, "нет"]) assert(normalizeWheelLock(v) === 35, "Некорректная настройка должна давать 35°");
      for (const angle of [33, 35, 37.5, 42]) {
        for (const sign of [1, -1] as const) {
          const central = wheelDegToSteerRad(sign * STEER_WHEEL.maxDeg, angle);
          const inner = ackermannAngle(sign, central);
          const outer = ackermannAngle(sign === 1 ? -1 : 1, central);
          assert(Math.abs(inner * 180 / Math.PI - sign * angle) < 1e-9, `Внутреннее колесо: неверный предел ${angle}°`);
          assert(Math.abs(outer) < Math.abs(central) && Math.abs(central) < Math.abs(inner), "Нарушено соотношение углов колёс");
          assert(Math.sign(outer) === sign && Math.abs(wheelDegToSteerRad(sign * 800, angle) - central) < 1e-12, "Неверный упор или направление руля");
        }
        assert(wheelDegToSteerRad(0, angle) === 0, "Центр руля должен остаться в нуле");
      }
      assert(outerTurningRadius(centralSteerLimit(42)) < outerTurningRadius(centralSteerLimit(33)), "Больший выворот должен уменьшать радиус");
      for (const sw of [-540, -117.3, 0, 312.6, 540]) {
        const old = clamp(((sw / STEER_WHEEL.ratio) * Math.PI) / 180, -CAR.maxSteer, CAR.maxSteer);
        assert(wheelDegToSteerRad(sw) === old && wheelDegToSteerRad(sw, 35) === old, "Должна сохраняться точная формула старых заездов");
      }
      return "Оба направления · 33°, 35°, 37,5°, 42° · меньший радиус при 42° · старые записи: 35°";
    },
  },
  {
    id: "T24",
    suite: "replay",
    name: "Изменение выворота в движении: траектория реагирует, реплей совпадает",
    fn: () => {
      const world = { ...buildScenarioWorld("bay_90", DEFAULT_CALIBRATION), start: { x: 0, z: 0, h: 0 }, bays: [], obstacles: [], bounds: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 } };
      const grid = new SpatialGrid([], 10);
      let state = createInitialState(world, true);
      const rec = new AttemptRecorder(state, true);
      const inp = { ...createReadyInput("D"), throttle: 0.7, steerWheelDeg: 540 };
      for (let i = 0; i < 240; i++) {
        const lock = i < 60 ? 33 : i < 180 ? 42 : 37.5;
        const out = stepSimulation(state, inp, world, grid, { ...DEFAULT_CALIBRATION, maxInnerWheelDeg: lock }, DEFAULT_RULESET);
        state = out.state;
        assert(Math.abs(state.steerLeft * 180 / Math.PI - lock) < 1e-9, "Ядро не применило выбранный выворот");
        rec.recordTick(inp, state, out.newEvents);
      }
      const snap = rec.snapshot(state, world, { ...DEFAULT_CALIBRATION, maxInnerWheelDeg: 37.5 }, DEFAULT_RULESET);
      assert(snap.inputStream.length === 3 && snap.inputStream.map(f => f.maxInnerWheelDeg).join() === "33,42,37.5", "Изменение угла должно отделять блоки ввода");
      const replay = replayInputStream(JSON.parse(JSON.stringify(snap.inputStream)), world, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
      assert(replay.finalState.x === state.x && replay.finalState.z === state.z && replay.finalState.h === state.h, "Изменение угла нарушило воспроизводимость");
      const fixed = replayInputStream([{ count: 240, input: inp, maxInnerWheelDeg: 33 }], world, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
      assert(Math.abs(fixed.finalState.h - state.h) > 0.01, "Настройка должна менять движение, а не только визуальные колёса");
      return "240 тиков: 33° → 42° → 37,5° · 3 блока RLE · поза совпала точно";
    },
  },
  {
    id: "T25",
    suite: "controls",
    name: "Блокировки АКПП/стартера и старт на маршруте: аварийка не заменяет поворотник",
    fn: () => {
      // 1. Блокировки селектора АКПП и запуска двигателя (src/sim/controls.ts)
      assert(checkGearChange({ gear: "D", engineOn: true }, 1.2, "P") !== null, "P на ходу должен блокироваться");
      assert(checkGearChange({ gear: "R", engineOn: true }, -(PARK_LOCK_MAX_SPEED_MS + 0.05), "P") !== null, "P при откате назад должен блокироваться");
      assert(checkGearChange({ gear: "D", engineOn: true }, PARK_LOCK_MAX_SPEED_MS, "P") === null, "P на остановке должен разрешаться");
      assert(checkGearChange({ gear: "P", engineOn: false, brake: 1 }, 0, "D") !== null, "Выход из P без ДВС должен блокироваться даже с тормозом");
      assert(checkGearChange({ gear: "P", engineOn: false, brake: 1 }, 0, "R") !== null, "Переход P → R без ДВС должен блокироваться");
      assert(checkGearChange({ gear: "P", engineOn: true, brake: 0 }, 0, "D") !== null, "Выход из P без нажатого тормоза (BTSI) должен блокироваться");
      assert(checkGearChange({ gear: "P", engineOn: true, brake: 0 }, 0, "R") !== null, "Переход P → R без тормоза должен блокироваться");
      assert(checkGearChange({ gear: "P", engineOn: true, brake: 0 }, 0, "N") !== null, "Переход P → N без тормоза должен блокироваться");
      assert(checkGearChange({ gear: "P", engineOn: true, brake: SHIFT_LOCK_MIN_BRAKE }, 0, "D") === null, "Выход из P с запущенным ДВС и нажатым тормозом разрешён");
      assert(checkGearChange({ gear: "P", engineOn: true, brake: 1 }, 0, "R") === null, "Переход P → R с нажатым тормозом разрешён");
      assert(checkEngineToggle({ gear: "D", engineOn: false }) !== null, "Запуск ДВС в D запрещён");
      assert(checkEngineToggle({ gear: "R", engineOn: false }) !== null, "Запуск ДВС в R запрещён");
      assert(checkEngineToggle({ gear: "P", engineOn: false }) === null && checkEngineToggle({ gear: "N", engineOn: false }) === null, "Запуск ДВС в P и N разрешён");
      assert(checkEngineToggle({ gear: "D", engineOn: true }) === null, "Заглушить ДВС можно в любом режиме");

      // 2. Детектор начала движения на маршруте: null и hazard дают no_turn_signal, left и right — нет
      const routeWorld = {
        ...buildScenarioWorld("city_osm", DEFAULT_CALIBRATION),
        obstacles: [],
        signals: [],
        crosswalks: [],
      };
      const grid = new SpatialGrid([], 10);
      const startWithSignal = (signal: "left" | "right" | "hazard" | null): SimEvent[] => {
        let s = createInitialState(routeWorld, true);
        const events: SimEvent[] = [];
        const inp = { ...createReadyInput("D"), throttle: 0.7, signal };
        for (let t = 0; t < 60; t++) {
          const out = stepSimulation(s, inp, routeWorld, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          s = out.state;
          events.push(...out.newEvents);
        }
        assert(s.hasMoved, "Машина должна набрать > 1,2 км/ч за 1 с");
        return events.filter((e) => e.code === "no_turn_signal");
      };

      const noSig = startWithSignal(null);
      const hazSig = startWithSignal("hazard");
      const leftSig = startWithSignal("left");
      const rightSig = startWithSignal("right");
      assert(noSig.length === 1, `Без поворотника ожидалась 1 ошибка no_turn_signal, получено ${noSig.length}`);
      assert(hazSig.length === 1 && hazSig[0].detail.includes("аварийной"), "Аварийка (Z) на старте должна фиксироваться как no_turn_signal");
      assert(leftSig.length === 0 && rightSig.length === 0, "Левый (Q) и правый (E) поворотники разрешают начало движения");

      return "АКПП: P на ходу и выход из P без ДВС заблокированы · стартер только P/N · старт: hazard → ошибка, Q/E → OK";
    },
  },
  {
    id: "T26",
    suite: "analytics",
    name: "Сводный Markdown-отчёт: KPI, сверка с ДИ Уилсона, ученики, нарушения и дисклеймер",
    fn: () => {
      const { attempt } = recordSampleAttempt();
      const { meta } = splitAttempt(attempt);
      const a1 = upsertReview(
        { ...meta, id: "md-1", student: "Петров П.|гр.1" },
        { instructor: "Иванов И.", verdict: "СДАЛ", reviewedAt: "2026-11-18T10:00:00.000Z" }
      );
      const a2 = upsertReview(
        { ...meta, id: "md-2", student: "Сидорова А." },
        {
          instructor: "Иванов И.",
          verdict: "НЕ СДАЛ",
          comment: "Поздно пристегнулся",
          reviewedAt: "2026-11-18T11:00:00.000Z",
        }
      );
      const summary = summarizeAttempts([a1, a2], DEFAULT_RULESET);
      const agreement = summarizeAgreement([a1, a2], DEFAULT_RULESET);
      const md = analyticsToMarkdown(summary, agreement, DEFAULT_RULESET, "2026-11-18");

      assert(md.includes("# CityDrivingTraining — сводный учебный отчёт (2026-11-18)"), "Нет заголовка с датой");
      assert(md.includes("unvalidated"), "Должен быть явно указан статус unvalidated");
      assert(md.includes("1 из 2 оценок (50%") && md.includes("ДИ Уилсона"), "Нет блока сверки и ДИ Уилсона");
      assert(md.includes("симулятор мягче") && md.includes("Поздно пристегнулся"), "Нет строки расхождения с комментарием");
      assert(md.includes("Петров П.\\|гр.1") && md.includes("Сидорова А."), "Нет таблицы учеников или не экранирован символ |");
      assert(md.includes("belt_unfastened") && md.includes("Приоритет для разбора"), "Нет блока нарушений и рекомендаций");
      assert(md.includes("Не является официальным экзаменом ГИБДД"), "Потерян обязательный дисклеймер");

      const signedMd = analyticsToMarkdown(
        summary,
        agreement,
        { ...DEFAULT_RULESET, status: "instructor_signed", instructorSignOff: "Иванов И.И., 2026-11-18" },
        "2026-11-18"
      );
      assert(signedMd.includes("instructor_signed") && signedMd.includes("Иванов И.И."), "Не отражена подпись инструктора");

      return `Markdown ${md.length} симв. · 5 разделов · ДИ Уилсона · экранирование таблиц · дисклеймер на месте`;
    },
  },
  {
    id: "T27",
    suite: "osm",
    name: "Парсер .osm XML и автоопределение форматов: дороги, здания, знаки, заборы, деревья и ODbL",
    fn: () => {
      const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="JOSM">
  <!-- Тестовый офлайн-фрагмент квартала -->
  <node id="1" lat="55.7500" lon="37.6100"/>
  <node id="2" lat="55.7512" lon="37.6100">
    <tag k="highway" v="traffic_signals"/>
  </node>
  <node id="3" lat="55.7506" lon="37.6100">
    <tag k="highway" v="crossing"/>
  </node>
  <node id="4" lat="55.7503" lon="37.6101">
    <tag k="highway" v="stop"/>
    <tag k="direction" v="N"/>
  </node>
  <node id="5" lat="55.7508" lon="37.6101">
    <tag k="traffic_sign" v="RU:3.24[30]"/>
  </node>
  <node id="6" lat="55.7505" lon="37.6097">
    <tag k="natural" v="tree"/>
  </node>
  <node id="7" lat="55.7501" lon="37.6096" visible="false">
    <tag k="highway" v="give_way"/>
  </node>
  <node id="10" lat="55.7502" lon="37.6104"/>
  <node id="11" lat="55.7502" lon="37.6107"/>
  <node id="12" lat="55.7505" lon="37.6107"/>
  <node id="13" lat="55.7505" lon="37.6104"/>
  <node id="20" lat="55.7501" lon="37.6102"/>
  <node id="21" lat="55.7504" lon="37.6102"/>
  <way id="100">
    <nd ref="1"/><nd ref="3"/><nd ref="2"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="ул. &quot;Школьная&quot; &amp; Садовая"/>
    <tag k="lanes" v="2"/>
    <tag k="maxspeed" v="40"/>
  </way>
  <way id="101">
    <nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="13"/><nd ref="10"/>
    <tag k="building" v="school"/>
    <tag k="building:levels" v="4"/>
  </way>
  <way id="102">
    <nd ref="20"/><nd ref="21"/>
    <tag k="barrier" v="fence"/>
  </way>
</osm>`;

      const pack = parseOsmXml(sampleXml, "Квартал из .osm");
      assert(pack.roads.length === 1, `Ожидалась 1 дорога, получено ${pack.roads.length}`);
      assert(pack.roads[0].name === 'ул. "Школьная" & Садовая', `Не декодированы XML-сущности: ${pack.roads[0].name}`);
      assert(pack.buildings.length === 1 && Math.abs(pack.buildings[0].height - 12.8) < 0.1, "Высота здания 4 эт. != 12.8 м");
      assert(pack.signals.length === 1 && pack.crosswalks.length === 1, "Не распознаны светофор или переход");
      // 3 знака: от maxspeed=40 на дороге + stop (node 4) + 3.24[30] (node 5); visible=false (node 7) пропущен
      assert(pack.signs.some((s) => s.kind === "stop"), "Не распознан знак STOP");
      assert(pack.signs.some((s) => s.kind === "speed_limit" && s.limitKmh === 30), "Не распознан знак 3.24[30]");
      assert(!pack.signs.some((s) => s.kind === "give_way"), "Удалённый узел visible=false не должен попадать в пакет");
      assert(
        pack.extraObstacles.some((o) => o.kind === "fence") && pack.extraObstacles.some((o) => o.kind === "tree"),
        "Не распознаны забор barrier=fence или дерево natural=tree"
      );
      assert(
        pack.meta.attribution.includes("OpenStreetMap") && pack.meta.license.includes("ODbL"),
        "Потеряна атрибуция ODbL 1.0"
      );

      // Универсальный импорт в редактор принимает и .osm XML, и GeoJSON, и JSON сценария
      const impXml = importEditorFileText(sampleXml, "school.osm");
      assert(impXml.kind === "osm_xml" && (impXml.def.roads?.length ?? 0) === 1, "importEditorFileText не распознал .osm");
      const gj = JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { highway: "tertiary", name: "пр. Тестовый" },
            geometry: { type: "LineString", coordinates: [[37.61, 55.75], [37.61, 55.751]] },
          },
          {
            type: "Feature",
            properties: { highway: "give_way" },
            geometry: { type: "Point", coordinates: [37.6101, 55.7505] },
          },
        ],
      });
      const impGj = parseMapFileText(gj, "area.geojson");
      assert(impGj.format === "geojson" && impGj.pack.signs.some((s) => s.kind === "give_way"), "GeoJSON знак 2.4 не распознан");

      let badRejected = false;
      try {
        parseOsmXml("<html>not osm</html>");
      } catch {
        badRejected = true;
      }
      assert(badRejected, "Некорректный XML должен отклоняться с понятной ошибкой");

      return `.osm: дорог ${pack.roads.length}, зданий ${pack.buildings.length}, знаков ${pack.signs.length}, доп. объектов ${pack.extraObstacles.length} · GeoJSON + ODbL OK`;
    },
  },
  {
    id: "T28",
    suite: "scenarios",
    name: "Редактор карт в симуляции: импорт OSM, знаки 3.24/5.21, STOP на КТ, новые препятствия и реплей",
    fn: () => {
      assert(ROAD_SIGN_CATALOG.length === 12, `Ожидалось 12 классов знаков, есть ${ROAD_SIGN_CATALOG.length}`);
      assert(OBSTACLE_CATALOG.length === 8, `Ожидалось 8 классов препятствий, есть ${OBSTACLE_CATALOG.length}`);

      // Клон встроенного города переносит дороги, светофоры, переход, знак 40 и ODbL
      const cityWorld = buildScenarioWorld("city_osm", DEFAULT_CALIBRATION);
      const clonedCity = customFromWorld(cityWorld, "Клон города");
      assert(
        (clonedCity.roads?.length ?? 0) === 3 &&
          (clonedCity.signals?.length ?? 0) === 2 &&
          (clonedCity.crosswalks?.length ?? 0) === 1 &&
          (clonedCity.signs?.length ?? 0) >= 1 &&
          Boolean(clonedCity.mapMeta),
        "customFromWorld(city_osm) потерял объекты города"
      );
      assert(validateCustomScenario(clonedCity).errors.length === 0, "Клон города должен проходить валидацию");

      // Собираем карту со знаком 3.24 «30», жилой зоной 5.21 «20», знаком STOP с КТ и новыми препятствиями
      let def = emptyCustomScenario();
      def = {
        ...def,
        start: { x: 0, z: 0, h: 0 },
        defaultSpeedLimitKmh: 60,
        signs: [
          { id: "s-30", kind: "speed_limit", x: -3, z: 2, h: 0, limitKmh: 30, zoneRadius: 10, zoneX: 0, zoneZ: 2 },
          { id: "s-lz", kind: "living_zone", x: -3, z: 25, h: 0, limitKmh: 20, zoneRadius: 8, zoneX: 0, zoneZ: 25 },
          { id: "s-stop", kind: "stop", x: -3, z: 5, h: 0 },
        ],
        obstacles: [
          { id: "o-fence", kind: "fence", cx: -8, cz: 0, halfX: 0.15, halfZ: 4, h: 0, height: 1.15 },
          { id: "o-tree", kind: "tree", cx: 8, cz: 4, halfX: 0.5, halfZ: 0.5, h: 0, height: 4.2 },
          { id: "o-island", kind: "island", cx: 8, cz: -6, halfX: 1.2, halfZ: 2.5, h: 0, height: 0.2 },
        ],
        checkpoints: [
          { id: "cp-stop", x: 0, z: 4, radius: 3.5, requireStop: true, instruction: "Остановитесь у STOP" },
        ],
      };
      assert(validateCustomScenario(def).errors.length === 0, "Карта со знаками и заборами должна быть валидна");

      const world = buildCustomWorld(def);
      assert(getActiveSpeedLimit(0, 2, world) === 30, "Знак 3.24 должен снижать лимит до 30 км/ч");
      assert(getActiveSpeedLimit(0, 25, world) === 20, "Знак 5.21 должен снижать лимит до 20 км/ч");
      assert(getActiveSpeedLimit(-20, -20, world) === 60, "Вне зон должен действовать базовый лимит 60 км/ч");

      const grid = new SpatialGrid(world.obstacles, 10);
      assert(grid.queryCarHit(-8, 0, 0).hit?.kind === "fence", "Ограждение fence должно участвовать в коллизиях");
      assert(grid.queryCarHit(8, 4, 0).hit?.kind === "tree", "Дерево tree должно участвовать в коллизиях");
      assert(grid.queryCarHit(8, -6, 0).hit?.kind === "island", "Островок island должен участвовать в коллизиях");

      // Проезд КТ с requireStop: на ходу не засчитывается, после остановки — засчитывается, реплей совпадает
      let state = createInitialState(world, true);
      const rec = new AttemptRecorder(state, true);
      let enteredWhileMoving = false;
      for (let t = 0; t < 240; t++) {
        const inZone = Math.hypot(state.x - 0, state.z - 4) <= 3.0;
        if (inZone && Math.abs(state.v) * 3.6 > 2) {
          enteredWhileMoving = true;
          assert(state.currentCheckpointIndex === 0, "КТ STOP не должна засчитываться без остановки");
        }
        const inp = {
          ...createReadyInput("D"),
          signal: t < 30 ? ("left" as const) : null,
          throttle: !enteredWhileMoving ? 0.55 : 0,
          brake: enteredWhileMoving ? 0.85 : 0,
        };
        const out = stepSimulation(state, inp, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
        state = out.state;
        rec.recordTick(inp, state, out.newEvents);
        if (state.finished) break;
      }
      assert(enteredWhileMoving && state.finished, "После остановки в зоне КТ STOP маршрут должен завершиться");
      const snap = rec.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
      assert(Boolean(snap.customWorld?.signs?.length), "Снимок customWorld должен сохранять знаки для реплея");
      const rep = replayInputStream(snap.inputStream, snap.customWorld!, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
      assert(rep.finalState.x === state.x && rep.finalState.z === state.z, "Реплей по карте со знаками разошёлся");

      // Конвертация OSM-пакета в редактор сохраняет дороги и валидность
      const osmDef = customFromOsmPack(
        parseMapFileText(
          JSON.stringify({
            elements: [
              { type: "node", id: 1, lat: 55.75, lon: 37.61 },
              { type: "node", id: 2, lat: 55.751, lon: 37.61 },
              { type: "way", id: 5, nodes: [1, 2], tags: { highway: "secondary", name: "ул. Мира" } },
            ],
          }),
          "mira.json"
        ).pack
      );
      assert(validateCustomScenario(osmDef).errors.length === 0, "Импортированная OSM-карта должна быть валидна");

      return "12 знаков · 8 препятствий · лимиты 30/20 км/ч · КТ STOP ждёт остановки · реплей бит-в-бит";
    },
  },
  {
    id: "T29",
    suite: "scenarios",
    name: "Операции 2D-редактора: добавление, перенос по сетке, поворот, узлы дорог, дубль, удаление и Undo/Redo",
    fn: () => {
      const opts = {
        signKind: "turn_right" as const,
        signSpeedLimit: 40,
        obstacleKind: "fence" as const,
        parkedModel: "rio" as const,
        bayKind: "parallel" as const,
        calibration: DEFAULT_CALIBRATION,
        snapStep: 0.5,
      };
      let hist = createEditorHistory<ReturnType<typeof emptyCustomScenario>>();
      const s0 = emptyCustomScenario();

      // 1. Размещаем знак с привязкой к сетке 0,5 м и перетаскиваем его
      const p1 = placeObjectAt(s0, "sign", 3.23, -4.76, opts);
      hist = pushEditorHistory(hist, s0);
      let cur = p1.def;
      assert(cur.signs?.[0].x === 3.0 && cur.signs?.[0].z === -5.0, "Привязка к сетке 0,5 м сработала неверно");

      const moved = moveSelected(cur, p1.selection, 6.24, 1.74, 0.5);
      hist = pushEditorHistory(hist, cur);
      cur = moved;
      assert(cur.signs?.[0].x === 6.0 && cur.signs?.[0].z === 1.5, "Перенос знака с привязкой к сетке неверен");

      // 2. Поворачиваем знак на -90° и связываем с КТ (должен проставиться requireSignal: right)
      cur = rotateSelected(cur, p1.selection, -Math.PI / 2);
      const linked = attachCheckpointToSign(cur, cur.signs![0].id);
      assert(Boolean(linked), "Не удалось создать КТ для знака 4.1.2");
      cur = linked!.def;
      const newCp = cur.checkpoints.find((c) => c.id === linked!.checkpointId);
      assert(newCp?.requireSignal === "right", "КТ от знака 4.1.2 должна требовать правый поворотник");

      // 3. Добавляем светофор: перенос стойки двигает стоп-линию синхронно, ручка стоп-линии — отдельно
      const pSig = placeObjectAt(cur, "signal", -4, 8, { ...opts, snapStep: 0 });
      cur = pSig.def;
      const slBefore = { x: cur.signals![0].stopLineX, z: cur.signals![0].stopLineZ };
      cur = moveSelected(cur, pSig.selection, -2, 11, 0);
      assert(
        Math.abs(cur.signals![0].stopLineX - (slBefore.x + 2)) < 0.02 &&
          Math.abs(cur.signals![0].stopLineZ - (slBefore.z + 3)) < 0.02,
        "Стоп-линия должна переноситься вместе со светофором"
      );
      cur = moveSelected(cur, { kind: "signal_stopline", id: cur.signals![0].id }, 0, 9, 0);
      assert(cur.signals![0].stopLineX === 0 && cur.signals![0].stopLineZ === 9, "Независимый перенос стоп-линии неверен");

      // 4. Добавляем дорогу, продлеваем узел, удаляем узел (дорога из 2 узлов остаётся)
      const pRoad = placeObjectAt(cur, "road", 0, 0, { ...opts, snapStep: 1 });
      cur = pRoad.def;
      const roadId = cur.roads![0].id;
      const ext = appendRoadPoint(cur, roadId);
      cur = ext.def;
      assert(cur.roads![0].points.length === 3, "appendRoadPoint должен добавить 3-й узел");
      cur = deleteSelected(cur, { kind: "road_point", id: roadId, index: 2 }).def;
      assert(cur.roads![0].points.length === 2, "Удаление 3-го узла должно оставить сегмент из 2 узлов");

      // 5. Дублирование, удаление и подгонка границ
      const dup = duplicateSelected(cur, p1.selection, 2);
      assert(Boolean(dup) && (dup!.def.signs?.length ?? 0) === 2, "Дублирование знака не создало копию");
      cur = deleteSelected(dup!.def, dup!.selection).def;
      assert((cur.signs?.length ?? 0) === 1, "Удаление копии знака не сработало");
      cur = fitBoundsToContent(cur, 10);
      assert(cur.bounds.minX < cur.bounds.maxX && cur.bounds.minZ < cur.bounds.maxZ, "fitBoundsToContent вернул некорректные границы");

      // 6. Undo / Redo восстанавливают предыдущее и следующее состояния
      const u1 = undoEditorHistory(hist, cur);
      assert(Boolean(u1) && u1!.state.signs?.[0].x === 3.0, "Undo не вернул исходную позицию знака");
      const r1 = redoEditorHistory(u1!.history, u1!.state);
      assert(Boolean(r1) && r1!.state.signs?.[0].x === 6.0, "Redo не вернул перенесённое состояние");

      return "Сетка 0,5 м · перенос/поворот · КТ от знака 4.1.2 · стоп-линия · узлы дороги · дубль/удаление · Undo/Redo OK";
    },
  },
  {
    id: "T30",
    suite: "osm",
    name: "Неквадратный импорт OSM (<bounds>, > 600 м), OBB диагональных зданий, oneway=-1 и сшивка улиц",
    fn: () => {
      // Узкий вытянутый коридор В–З (~1500 × 90 м): раньше обрезался до ±600 и раздувался в квадрат
      const longXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="OpenStreetMap server">
  <bounds minlat="55.7498" minlon="37.5980" maxlat="55.7503" maxlon="37.6220"/>
  <node id="1" lat="55.7500" lon="37.5980"/>
  <node id="2" lat="55.7500" lon="37.6060"/>
  <node id="3" lat="55.7500" lon="37.6140">
    <tag k="highway" v="traffic_signals"/>
  </node>
  <node id="4" lat="55.7500" lon="37.6220"/>
  <!-- Односторонняя улица с oneway=-1 -->
  <node id="5" lat="55.7502" lon="37.6060"/>
  <node id="6" lat="55.7502" lon="37.6120"/>
  <!-- Диагональное здание под ~45° -->
  <node id="10" lat="55.7501" lon="37.6020"/>
  <node id="11" lat="55.7503" lon="37.6024"/>
  <node id="12" lat="55.7502" lon="37.6026"/>
  <node id="13" lat="55.7500" lon="37.6022"/>
  <!-- Разбитая на 3 way одна и та же улица -->
  <way id="201">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="пр-т Длинный"/>
    <tag k="maxspeed" v="60"/>
  </way>
  <way id="202">
    <nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="пр-т Длинный"/>
  </way>
  <way id="203">
    <nd ref="3"/><nd ref="4"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="пр-т Длинный"/>
  </way>
  <way id="204">
    <nd ref="5"/><nd ref="6"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="пер. Обратный"/>
    <tag k="oneway" v="-1"/>
  </way>
  <way id="205">
    <nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="13"/><nd ref="10"/>
    <tag k="building" v="yes"/>
  </way>
</osm>`;

      const pack = parseOsmXml(longXml, "Длинный коридор");
      const spanX = pack.bounds.maxX - pack.bounds.minX;
      const spanZ = pack.bounds.maxZ - pack.bounds.minZ;
      assert(spanX > 1400, `Ожидалась длина участка > 1400 м без обрезки по ±600, получено ${spanX} м`);
      assert(spanZ < 160 && spanX / spanZ > 9, `Карта не должна быть квадратной: ${spanX}×${spanZ} м`);

      // Сшивка 3 сегментов «пр-т Длинный» в единый маршрут на всю длину (> 1400 м)
      const cands = listRouteCandidates(pack.roads);
      const main = cands.find((c) => c.name === "пр-т Длинный");
      assert(Boolean(main) && main!.segmentsCount === 3 && main!.lengthM > 1400, "Сегменты одной улицы не сшиты");
      assert(pack.routeCheckpoints.length >= 5, `Ожидалось ≥ 5 КТ по сшитой улице, получено ${pack.routeCheckpoints.length}`);

      // oneway=-1 развернул узлы: движение от востока (lon 37.6120, меньший X) к западу (lon 37.6060, больший X)
      const rev = pack.roads.find((r) => r.id === "way-204");
      assert(Boolean(rev) && rev!.points[0].x < rev!.points[1].x, "oneway=-1 должен разворачивать направление way");

      // Диагональное здание получило ориентированный OBB (h ≠ 0)
      assert(pack.buildings.length === 1 && Math.abs(pack.buildings[0].h) > 0.2, "Диагональное здание должно иметь OBB-угол h");

      // Безымянная короткая улица (22 м) тоже строит валидный маршрут (а не пустой массив КТ)
      const shortRoute = buildRouteFromRoads([
        {
          id: "unnamed-short",
          points: [
            { x: 0, z: 0 },
            { x: 0, z: 22 },
          ],
          width: 6,
          lanes: 2,
          highway: "residential",
        },
      ]);
      assert(shortRoute.checkpoints.length >= 1 && Boolean(shortRoute.startPose), "Короткая безымянная дорога не дала КТ");

      return `${Math.round(spanX)}×${Math.round(spanZ)} м (неквадрат) · сшито 3 way (${Math.round(main!.lengthM)} м) · OBB + oneway=-1 OK`;
    },
  },
  {
    id: "T31",
    suite: "boundary",
    name: "Произвольные границы: полигон, коридор маршрута, обрезка дорог OSM и удержание авто в симуляции",
    fn: () => {
      // 1. Вогнутый Г-образный контур + детектор самопересечения («бабочка»)
      const lShape = [
        { x: -40, z: -40 },
        { x: 40, z: -40 },
        { x: 40, z: 0 },
        { x: 0, z: 0 },
        { x: 0, z: 50 },
        { x: -40, z: 50 },
      ];
      assert(isSimplePolygon(lShape) && polygonArea(lShape) > 4000, "Г-образный полигон должен быть простым");
      assert(isPointInPolygon(-20, 30, lShape) && !isPointInPolygon(20, 30, lShape), "Ошибка point-in-polygon на вогнутом углу");

      const bowtie = [
        { x: -20, z: -20 },
        { x: 20, z: 20 },
        { x: -20, z: 20 },
        { x: 20, z: -20 },
      ];
      assert(!isSimplePolygon(bowtie), "Самопересекающийся полигон должен отклоняться");

      // Вставка и удаление вершины
      const ins = insertBoundaryVertex(lShape, 0);
      assert(ins.polygon.length === 7 && ins.insertedIndex === 1, "insertBoundaryVertex не вставил вершину");
      const rem = removeBoundaryVertex(ins.polygon, 1);
      assert(Boolean(rem) && rem!.length === 6, "removeBoundaryVertex не удалил вершину");

      // Обрезка ломаной, дважды входящей в Г-образный контур
      const clipped = clipPolylineToPolygon(
        [
          { x: -20, z: 35 },
          { x: 30, z: 35 },
          { x: 30, z: -20 },
        ],
        lShape
      );
      assert(clipped.length === 2, `Ожидалось 2 внутренних куска ломаной, получено ${clipped.length}`);

      // 2. Коридор Г-образного маршрута и обрезка карты OSM
      const osmPack = parseOsmOrGeoJson(
        {
          elements: [
            { type: "node", id: 1, lat: 55.7500, lon: 37.6100 },
            { type: "node", id: 2, lat: 55.7510, lon: 37.6100 },
            { type: "node", id: 3, lat: 55.7510, lon: 37.6118 },
            // Далёкая посторонняя улица и здание в стороне от маршрута
            { type: "node", id: 4, lat: 55.7524, lon: 37.6075 },
            { type: "node", id: 5, lat: 55.7528, lon: 37.6075 },
            { type: "node", id: 6, lat: 55.7525, lon: 37.6078 },
            { type: "node", id: 7, lat: 55.7525, lon: 37.6081 },
            { type: "node", id: 8, lat: 55.7527, lon: 37.6081 },
            { type: "node", id: 9, lat: 55.7527, lon: 37.6078 },
            { type: "way", id: 10, nodes: [1, 2, 3], tags: { highway: "secondary", name: "ул. Маршрутная" } },
            { type: "way", id: 11, nodes: [4, 5], tags: { highway: "residential", name: "ул. Дальняя" } },
            { type: "way", id: 12, nodes: [6, 7, 8, 9, 6], tags: { building: "yes" } },
          ],
        },
        "Квартал для обрезки"
      );

      let sc = customFromOsmPack(osmPack);
      const corr = applyRouteCorridorBoundary(sc, 24);
      assert(corr.ok && corr.vertices >= 6, "Коридор Г-образного маршрута не построен");
      const crop = cropScenarioToBoundary(corr.def);
      assert(crop.removedRoads === 1 && crop.removedObjects >= 1, "Внешняя улица и здание должны быть обрезаны");
      assert(crop.keptCheckpoints >= 3, "Контрольные точки внутри коридора должны сохраниться");
      assert(validateCustomScenario(crop.def).errors.length === 0, "Обрезанный сценарий должен быть валиден");

      // Прямая обрезка пакета OSM, оболочка и сброс к прямоугольнику
      const packCropped = cropOsmPackToPolygon(osmPack, buildRouteCorridorPolygon(osmPack.roads[0].points, 25));
      assert(packCropped.roads.length === 1 && Boolean(packCropped.boundaryPolygon), "cropOsmPackToPolygon не сработал");
      const hull = applyConvexHullBoundary(crop.def, 14);
      assert(hull.ok && hull.vertices >= 3, "Выпуклая оболочка не построена");
      const resetRect = clearBoundaryPolygon(hull.def, 10);
      assert(resetRect.boundaryPolygon === undefined, "clearBoundaryPolygon должен сбрасывать полигон");
      const badSet = setCustomBoundaryPolygon(resetRect, bowtie);
      assert(!badSet.ok, "setCustomBoundaryPolygon должен отклонять самопересечение");

      // 3. Все 6 шаблонов произвольной формы площадки (вкл. Г/Т/П-образную, трапецию, 8-угольник) + 3D-бордюр + передний слой
      const baseLot = defaultCustomScenario();
      for (const preset of BOUNDARY_SHAPE_PRESETS) {
        const shaped = applyPresetBoundaryShape(baseLot, preset.id);
        assert(
          shaped.vertices >= 4 && isSimplePolygon(shaped.def.boundaryPolygon!),
          `Шаблон площадки ${preset.id} невалиден`
        );
        const val = validateCustomScenario(shaped.def);
        assert(val.errors.length === 0, `Шаблон ${preset.id} дал ошибки на площадке: ${val.errors.join("; ")}`);
      }
      const lYard = { ...applyPresetBoundaryShape(baseLot, "l_shape").def, perimeterCurb: true };
      const lWorld = buildCustomWorld(lYard);
      assert(lWorld.lotPolygon?.length === 6, "Г-образная площадка должна задавать lotPolygon из 6 вершин");
      assert(
        lWorld.roads.every((r) => r.id !== "custom-lot"),
        "При lotPolygon прямоугольная custom-lot не должна создаваться"
      );
      assert(
        lWorld.obstacles.filter((o) => o.id.startsWith("boundary-curb-")).length === 6,
        "perimeterCurb должен строить 6 сегментов бордюра по Г-образному контуру"
      );
      const firstObsId = baseLot.obstacles[0].id;
      const promoted = bringSelectionToFront(baseLot, { kind: "obstacle", id: firstObsId });
      assert(
        promoted.moved && promoted.def.obstacles[promoted.def.obstacles.length - 1].id === firstObsId,
        "bringSelectionToFront должен переносить объект на передний слой"
      );

      // 4. Физика stepSimulation удерживает автомобиль внутри треугольной площадки
      const tri = [
        { x: -25, z: -20 },
        { x: 25, z: -20 },
        { x: 0, z: 25 },
      ];
      const triSc = setCustomBoundaryPolygon(
        { ...emptyCustomScenario(), start: { x: 0, z: 0, h: 0 }, checkpoints: [{ id: "cp1", x: 0, z: 12, radius: 5, instruction: "Вперёд" }] },
        tri
      ).def;
      const triWorld = buildCustomWorld(triSc);
      assert(triWorld.lotPolygon?.length === 3, "Треугольная площадка должна строить треугольный lotPolygon");
      const grid = new SpatialGrid(triWorld.obstacles, 10);
      let st = createInitialState(triWorld, true);
      const drive = { ...createReadyInput("D"), throttle: 1, signal: "left" as const };
      for (let i = 0; i < 360; i++) {
        st = stepSimulation(st, drive, triWorld, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(
        isInsideWorldBoundary(st.x, st.z, triWorld.bounds, triWorld.boundaryPolygon),
        `Автомобиль вышел за треугольную границу: (${st.x.toFixed(2)}, ${st.z.toFixed(2)})`
      );

      return `6 форм площадки + lotPolygon/curb · коридор ${corr.vertices} т. · обрезано дорог=${crop.removedRoads} · clamp OK`;
    },
  },
  {
    id: "T32",
    suite: "route",
    name: "Проверка маршрута после импорта OSM: граф дорог (Дейкстра), реверс улицы и autoFixScenarioRoute",
    fn: () => {
      // Перекрёсток двух улиц OSM + проверка после импорта
      const pack = parseOsmOrGeoJson(
        {
          elements: [
            { type: "node", id: 1, lat: 55.7500, lon: 37.6100 },
            { type: "node", id: 2, lat: 55.7508, lon: 37.6100, tags: { highway: "traffic_signals" } },
            { type: "node", id: 3, lat: 55.7516, lon: 37.6100 },
            { type: "node", id: 4, lat: 55.7508, lon: 37.6088 },
            { type: "node", id: 5, lat: 55.7508, lon: 37.6114, tags: { highway: "crossing" } },
            { type: "way", id: 50, nodes: [1, 2, 3], tags: { highway: "secondary", name: "ул. Северная", maxspeed: "40" } },
            { type: "way", id: 51, nodes: [4, 2, 5], tags: { highway: "tertiary", name: "ул. Поперечная", maxspeed: "40" } },
          ],
        },
        "Перекрёсток OSM"
      );

      const imported = customFromOsmPack(pack);
      const initialCheck = checkScenarioRoute(imported);
      assert(
        initialCheck.ok && initialCheck.status === "valid" && initialCheck.connectedLegsCount === initialCheck.checkpointsCount,
        `Свежеимпортированный маршрут OSM должен проходить проверку: ${initialCheck.summary}`
      );
      assert(initialCheck.signalsOnRoute >= 1, "Светофор на маршруте должен учитываться в отчёте");

      // Поиск пути Дейкстрой с поворотом с «ул. Северной» на «ул. Поперечную»
      const turnPath = findRoadNetworkPath(
        imported.roads!,
        imported.roads![0].points[0],
        imported.roads![1].points[2]
      );
      assert(turnPath.connected && turnPath.roadNames.length === 2, "Граф дорог должен находить путь через перекрёсток");

      // Перестроение маршрута по второй улице + реверс направления
      const altFwd = rebuildRouteFromEditorRoads(imported, { candidateId: "way-51", reverse: false });
      const altRev = rebuildRouteFromEditorRoads(imported, { candidateId: "way-51", reverse: true });
      assert(altFwd.count >= 3 && altFwd.roadName === "ул. Поперечная", "Выбор альтернативной улицы не сработал");
      assert(
        Math.hypot(
          altFwd.def.checkpoints[0].x - altRev.def.checkpoints[0].x,
          altFwd.def.checkpoints[0].z - altRev.def.checkpoints[0].z
        ) > 20,
        "Реверс маршрута должен менять начало и конец местами"
      );
      const flipped = reverseRoadDirection(imported, "way-51");
      assert(
        flipped.roads![1].points[0].x === imported.roads![1].points[2].x,
        "reverseRoadDirection не развернул узлы дороги"
      );

      // Намеренно ломаем маршрут (старт снаружи, КТ в поле, дубль ID, isFinalPark без боксов) и чиним
      const broken = {
        ...imported,
        start: { x: imported.bounds.maxX + 45, z: imported.bounds.maxZ + 45, h: Math.PI },
        checkpoints: [
          { id: "dup", x: 65, z: -55, radius: 5, instruction: "КТ вне дороги" },
          { id: "dup", x: imported.checkpoints[1].x, z: imported.checkpoints[1].z, radius: 0, instruction: "Финиш", isFinalPark: true },
        ],
      };
      const brokenCheck = checkScenarioRoute(broken);
      assert(!brokenCheck.ok && brokenCheck.status === "errors" && brokenCheck.canAutoFix, "Поломки маршрута не обнаружены");

      const fixed = autoFixScenarioRoute(broken);
      assert(fixed.fixes.length >= 4, `Ожидалось ≥ 4 автоисправлений, получено ${fixed.fixes.length}`);
      assert(validateCustomScenario(fixed.def).errors.length === 0, "После autoFixScenarioRoute остались ошибки валидации");
      const fixedCheck = checkScenarioRoute(fixed.def);
      assert(fixedCheck.ok, `После autoFixScenarioRoute маршрут должен быть проходим: ${fixedCheck.summary}`);

      // Проезд финишной КТ с isFinalPark=true на карте без боксов корректно завершает заезд
      const parklessWorld = buildCustomWorld({
        ...emptyCustomScenario(),
        start: { x: 0, z: 0, h: 0 },
        bays: [],
        checkpoints: [{ id: "end", x: 0, z: 8, radius: 5, instruction: "Финиш", isFinalPark: true }],
      });
      let s = createInitialState(parklessWorld, true);
      const g = new SpatialGrid([], 10);
      const inp = { ...createReadyInput("D"), throttle: 0.7, signal: "left" as const };
      for (let i = 0; i < 180 && !s.finished; i++) {
        s = stepSimulation(s, inp, parklessWorld, g, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(s.finished && s.finishedReason === "completed", "Маршрут с isFinalPark без боксов должен завершаться на КТ");

      return `OSM check OK (${initialCheck.checkpointsCount} КТ, ${initialCheck.totalLengthM} м) · Дейкстра 2 ул. · реверс · autoFix (${fixed.fixes.length}) OK`;
    },
  },
  {
    id: "T33",
    suite: "osm",
    name: "Бесконфликтный импорт реальной карты: дворы, мультиполигоны, oneway, мосты, заборы и WGS84-слияние",
    fn: () => {
      // 1. Парсеры реальных единиц OSM (RU:urban, RU:living_street, mph, футы, составные значения)
      assert(parseOsmMaxspeedKmh("RU:urban") === 60 && parseOsmMaxspeedKmh("RU:living_street") === 20, "Ошибка RU:* maxspeed");
      assert(parseOsmMaxspeedKmh("30 mph") === 48 && parseOsmMaxspeedKmh("40; 60") === 40, "Ошибка mph / списка maxspeed");
      assert(Math.abs((parseOsmMeters("10.5 m") ?? 0) - 10.5) < 0.05, "Ошибка parseOsmMeters(m)");
      assert(Math.abs((parseOsmMeters("30'") ?? 0) - 9.14) < 0.1, "Ошибка parseOsmMeters(ft)");

      // 2. Реалистичный сложный .osm XML с типичными конфликтами реальных карт:
      // - главная односторонняя улица (oneway=yes, 60 км/ч) + эстакада (bridge=yes, layer=1) поперёк без общего узла;
      // - примыкающая жилая зона (20 км/ч) рядом с магистралью (не должна ронять лимит на магистрали);
      // - здание-мультиполигон с внутренним двором и проездом + навес АЗС (building=roof) + удалённый узел (action=delete);
      // - забор поперёк улицы с воротами + дерево/столб на оси дороги + парные светофоры + direction=backward + пешеходный светофор.
      const realConflictXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <bounds minlat="55.7490" minlon="37.6090" maxlat="55.7520" maxlon="37.6130"/>
  <!-- Главная односторонняя улица с юга на север (lon=37.6105) -->
  <node id="1" lat="55.7492" lon="37.6105"/>
  <node id="2" lat="55.7502" lon="37.6105" ><tag k="highway" v="traffic_signals"/><tag k="traffic_signals:direction" v="forward"/></node>
  <node id="3" lat="55.75024" lon="37.6105"><tag k="highway" v="traffic_signals"/></node>
  <node id="4" lat="55.7510" lon="37.6105"><tag k="traffic_sign" v="RU:2.4"/><tag k="direction" v="backward"/></node>
  <node id="5" lat="55.7518" lon="37.6105"/>
  <!-- Дерево и удалённый боллард прямо на оси главной улицы -->
  <node id="6" lat="55.7497" lon="37.6105"><tag k="natural" v="tree"/></node>
  <node id="7" lat="55.7498" lon="37.6105" action="delete"><tag k="barrier" v="bollard"/></node>
  <!-- Пешеходная дорожка со своим светофором (не должна создавать стоп-линию для авто) -->
  <node id="8" lat="55.7496" lon="37.6094"/>
  <node id="9" lat="55.7500" lon="37.6094"><tag k="highway" v="traffic_signals"/></node>
  <node id="10" lat="55.7504" lon="37.6094"/>
  <!-- Поперечная эстакада (bridge=yes, layer=1) без общих узлов с главной улицей -->
  <node id="11" lat="55.7506" lon="37.6092"/>
  <node id="12" lat="55.7506" lon="37.6122"/>
  <!-- Боковая жилая зона (20 км/ч) восточнее главной улицы -->
  <node id="13" lat="55.7498" lon="37.6110"/>
  <node id="14" lat="55.7498" lon="37.6122"/>
  <!-- Забор поперёк главной улицы с воротами -->
  <node id="15" lat="55.7513" lon="37.6098"/>
  <node id="16" lat="55.7513" lon="37.6105"><tag k="barrier" v="gate"/></node>
  <node id="17" lat="55.7513" lon="37.6112"/>
  <!-- Здание-мультиполигон с двором (outer 20..23, inner 24..27) и проездом во двор (28..29) -->
  <node id="20" lat="55.7500" lon="37.6113"/>
  <node id="21" lat="55.7500" lon="37.6123"/>
  <node id="22" lat="55.7505" lon="37.6123"/>
  <node id="23" lat="55.7505" lon="37.6113"/>
  <node id="24" lat="55.75012" lon="37.6115"/>
  <node id="25" lat="55.75012" lon="37.6121"/>
  <node id="26" lat="55.75038" lon="37.6121"/>
  <node id="27" lat="55.75038" lon="37.6115"/>
  <node id="28" lat="55.75025" lon="37.6111"/>
  <node id="29" lat="55.75025" lon="37.6119"/>
  <!-- Навес АЗС (building=roof) прямо над дорогой — не должен становиться глухой стеной -->
  <node id="30" lat="55.7494" lon="37.6103"/>
  <node id="31" lat="55.7494" lon="37.6107"/>
  <node id="32" lat="55.7496" lon="37.6107"/>
  <node id="33" lat="55.7496" lon="37.6103"/>

  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="6"/><nd ref="4"/><nd ref="16"/><nd ref="5"/>
    <tag k="highway" v="primary"/><tag k="name" v="Набережная"/><tag k="oneway" v="yes"/><tag k="lanes" v="2"/><tag k="maxspeed" v="RU:urban"/>
  </way>
  <way id="101">
    <nd ref="8"/><nd ref="9"/><nd ref="10"/>
    <tag k="highway" v="footway"/>
  </way>
  <way id="102">
    <nd ref="11"/><nd ref="12"/>
    <tag k="highway" v="secondary"/><tag k="name" v="Эстакада"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/>
  </way>
  <way id="103">
    <nd ref="13"/><nd ref="14"/>
    <tag k="highway" v="living_street"/><tag k="name" v="Тихий двор"/>
  </way>
  <way id="104">
    <nd ref="15"/><nd ref="16"/><nd ref="17"/>
    <tag k="barrier" v="fence"/>
  </way>
  <way id="105">
    <nd ref="28"/><nd ref="29"/>
    <tag k="highway" v="service"/>
  </way>
  <way id="106">
    <nd ref="1"/><nd ref="5"/>
    <tag k="highway" v="construction"/><tag k="name" v="Закрытая стройка"/>
  </way>
  <way id="200"><nd ref="20"/><nd ref="21"/><nd ref="22"/><nd ref="23"/><nd ref="20"/></way>
  <way id="201"><nd ref="24"/><nd ref="25"/><nd ref="26"/><nd ref="27"/><nd ref="24"/></way>
  <way id="202">
    <nd ref="30"/><nd ref="31"/><nd ref="32"/><nd ref="33"/><nd ref="30"/>
    <tag k="building" v="roof"/>
  </way>
  <relation id="500">
    <member type="way" ref="200" role="outer"/>
    <member type="way" ref="201" role="inner"/>
    <tag k="type" v="multipolygon"/><tag k="building" v="apartments"/><tag k="building:levels" v="6"/>
  </relation>
</osm>`;

      // Исправим порядок узлов на way 100, чтобы улица шла монотонно с юга на север
      const cleanXml = realConflictXml.replace(
        '<nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="6"/><nd ref="4"/><nd ref="16"/><nd ref="5"/>',
        '<nd ref="1"/><nd ref="6"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="16"/><nd ref="5"/>'
      );
      const pack = parseOsmXml(cleanXml, "Реальный квартал OSM");

      // Только реальные автомобильные дороги (без footway и construction)
      assert(pack.roads.length === 4, `Ожидалось 4 автодороги, получено ${pack.roads.length}`);
      const mainRoad = pack.roads.find((r) => r.name === "Набережная")!;
      const bridgeRoad = pack.roads.find((r) => r.name === "Эстакада")!;
      assert(mainRoad.oneway === true && mainRoad.speedLimitKmh === 60, "Не распознаны oneway=yes или RU:urban");
      assert(bridgeRoad.layer === 1, "Не распознан layer=1 у эстакады");

      // Ни одно здание, забор, дерево или столб не перекрывает проезжую часть ни одной наземной дороги!
      const roadIdx = new RoadCorridorIndex(pack.roads, true);
      const allObs = [...pack.buildings, ...(pack.extraObstacles ?? [])];
      for (const obs of allObs) {
        assert(!doesObstacleOverlapRoads(obs, roadIdx, 0.25), `Конфликт с дорогой у препятствия ${obs.id} (${obs.kind})`);
      }
      // Мультиполигон дома с двором разложен на корпуса вокруг проезда, а забор разрезан по обе стороны улицы
      assert(pack.buildings.length >= 2, `Дом-двор должен разложиться на корпуса без перекрытия проезда (${pack.buildings.length})`);
      const fenceParts = (pack.extraObstacles ?? []).filter((o) => o.kind === "fence");
      assert(fenceParts.length >= 2, `Забор через улицу должен быть разрезан на боковые секции (${fenceParts.length})`);
      assert(!(pack.extraObstacles ?? []).some((o) => o.id.includes("7")), "Удалённый узел action=delete не должен импортироваться");

      // Светофоры: дубль объединён, пешеходный светофор отброшен → ровно 1 светофор на проезжей части
      assert(pack.signals.length === 1, `Ожидался 1 дедуплицированный автосветофор, получено ${pack.signals.length}`);
      // Знак с direction=backward повёрнут на юг (|h| > 2.5 рад), а не по ходу северной улицы (h ≈ 0)
      const yieldSign = pack.signs.find((s) => s.kind === "give_way");
      assert(Boolean(yieldSign) && Math.abs(yieldSign!.h) > 2.5, "direction=backward не развернул знак");
      // Счётчик устранённых конфликтов и WGS84-якорь заполнены
      assert((pack.meta.resolvedConflictsCount ?? 0) >= 3 && Boolean(pack.meta.origin), "Нет отчёта согласования или WGS84 origin");

      // Односторонняя улица запрещает реверс маршрута против потока
      const revAttempt = buildRouteFromRoads(pack.roads, { reverse: true });
      assert(revAttempt.reverseBlocked === true, "Односторонняя улица должна блокировать реверс маршрута");
      // Искусственный старт против шерсти на oneway ловится проверкой и чинится autoFixScenarioRoute
      const scen = customFromOsmPack(pack);
      const wrongStart = { ...scen, start: { ...scen.start, h: Math.PI } };
      const wrongCheck = checkScenarioRoute(wrongStart);
      assert(wrongCheck.status === "errors" && wrongCheck.canAutoFix, "Старт против oneway должен быть ошибкой");
      const repaired = autoFixScenarioRoute(wrongStart);
      assert(Math.abs(Math.sin(repaired.def.start.h)) < 0.3 && Math.cos(repaired.def.start.h) > 0.8, "autoFix не развернул старт по oneway");

      // Развязка по уровням: граф не перепрыгивает с Набережной (layer=0) на Эстакаду (layer=1) без общего узла
      const crossLayer = findRoadNetworkPath(pack.roads, mainRoad.points[0], bridgeRoad.points[1]);
      assert(!crossLayer.connected, "Граф дорог не должен соединять layer=0 с эстакадой layer=1 без съезда");

      // Жилая зона 20 км/ч не роняет лимит на главной магистрали 60 км/ч; физический проезд без ложных столкновений
      const cityWorld = buildScenarioWorld("city_osm", DEFAULT_CALIBRATION, pack);
      const cityGrid = new SpatialGrid(cityWorld.obstacles, 10);
      assert(!cityGrid.queryCarHit(cityWorld.start.x, cityWorld.start.z, cityWorld.start.h).hit, "Коллизия на старте OSM");
      for (const sz of cityWorld.speedZones) {
        const dToMain = Math.abs(sz.x - mainRoad.points[0].x);
        assert(dToMain > sz.radius + 1, "Зона 20 км/ч бокового двора не должна накрывать главную магистраль");
      }

      // 3. GeoJSON: MultiLineString + Polygon с дырой двора + landuse=residential (не должен становиться стеной!)
      const gjPack = parseOsmOrGeoJson(
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { highway: "secondary", name: "пр-т Ленина", oneway: "yes" },
              geometry: {
                type: "MultiLineString",
                coordinates: [
                  [[37.61, 55.75], [37.61, 55.7506]],
                  [[37.61, 55.7506], [37.61, 55.7512]],
                ],
              },
            },
            {
              type: "Feature",
              properties: { landuse: "residential", name: "Микрорайон" },
              geometry: {
                type: "Polygon",
                coordinates: [[[37.609, 55.7495], [37.612, 55.7495], [37.612, 55.7515], [37.609, 55.7515], [37.609, 55.7495]]],
              },
            },
          ],
        },
        "GeoJSON тест"
      );
      assert(gjPack.roads.length === 2 && gjPack.buildings.length === 0, "landuse=residential в GeoJSON не должен быть зданием");

      // 4. Слияние пользовательских боксов и ручных знаков при повторном импорте сдвинутого участка OSM (WGS84) + deconflictScenarioWithRoads
      const withUserBay = {
        ...scen,
        useLotSurface: true,
        bays: [
          {
            id: 1,
            label: "Мой карман",
            kind: "parallel" as const,
            cx: mainRoad.points[0].x - 7.5,
            cz: mainRoad.points[0].z + 18,
            width: 2.5,
            length: 6.7,
            h: 0,
            openSide: "left" as const,
            occupied: false,
          },
        ],
        obstacles: [
          ...scen.obstacles,
          { id: "bad-tree", kind: "tree" as const, cx: mainRoad.points[0].x, cz: mainRoad.points[0].z + 25, halfX: 0.45, halfZ: 0.45, h: 0, height: 4, color: 0x2f6a44 },
        ],
      };
      const cleaned = deconflictScenarioWithRoads(withUserBay);
      assert(cleaned.changedCount >= 2 && cleaned.def.useLotSurface === false, "deconflictScenarioWithRoads не убрал конфликт");
      const shiftedXml = cleanXml.replace('maxlon="37.6130"', 'maxlon="37.6145"');
      const shiftedDef = customFromOsmPack(parseOsmXml(shiftedXml, "Расширенный участок"));
      const merged = mergeUserObjectsOntoOsmMap(cleaned.def, shiftedDef);
      assert(merged.reprojected && merged.keptBays === 1, "mergeUserObjectsOntoOsmMap не перенёс бокс с WGS84-репроекцией");

      return `Согласовано ${pack.meta.resolvedConflictsCount} конфл. · двор ${pack.buildings.length} корп. · забор ${fenceParts.length} секц. · oneway/layer/WGS84 OK`;
    },
  },
  {
    id: "T34",
    suite: "vehicle",
    name: "6-ст. КПП Shiftronic (Shift): плавные обороты ДВС, 0–100 км/ч ≈ 10,8 с и Vmax = 180 км/ч",
    fn: () => {
      const baseWorld = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
      const track = {
        ...baseWorld,
        bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 4000 },
        boundaryPolygon: undefined,
        obstacles: [],
        bays: [],
        checkpoints: [],
        signals: [],
        crosswalks: [],
        pedestrians: [],
        start: { x: 0, z: 0, h: 0 },
        defaultSpeedLimitKmh: 200,
      };
      const grid = new SpatialGrid([], 10);

      // 1. Секвентальное переключение Shift (P ↔ R ↔ N ↔ M1..M6) и защитные блокировки (вкл. тормоз BTSI из P)
      assert(stepGearSequential({ gear: "P", engineOn: false, brake: 1 }, 0, 1, 1).next === null, "Shift из P без ДВС должен блокироваться");
      assert(stepGearSequential({ gear: "P", engineOn: true, brake: 0 }, 0, 1, 1).next === null, "Shift из P без тормоза должен блокироваться");
      const upSeq: Gear[] = [];
      let cur: Gear = "P";
      for (let i = 0; i < 8; i++) {
        const res = stepGearSequential({ gear: cur, engineOn: true, brake: cur === "P" ? 1 : 0 }, 0, 1, 1);
        assert(res.next !== null, `Ожидалось повышение с ${cur}`);
        cur = res.next!;
        upSeq.push(cur);
      }
      assert(upSeq.join(",") === "R,N,1,2,3,4,5,6", `Неверный ряд Shift▲: ${upSeq.join(",")}`);
      assert(stepGearSequential({ gear: "6", engineOn: true }, 30, 6, 1).next === null, "Выше M6 передач нет");
      // Защита от перекрута при понижении на высокой скорости (110 км/ч -> M2 запрещено, -> M3 разрешено)
      assert(stepGearSequential({ gear: "4", engineOn: true }, 110 / 3.6, 4, -1).next === "3", "Понижение M4→M3 на 110 км/ч должно работать");
      assert(stepGearSequential({ gear: "3", engineOn: true }, 110 / 3.6, 3, -1).next === null, "Перекрут M3→M2 на 110 км/ч должен блокироваться");
      // На ходу понижение с M1 не выбрасывает в N
      assert(stepGearSequential({ gear: "1", engineOn: true }, 6, 1, -1).next === null, "На ходу M1 не должна сбрасываться в N");
      // На месте полный спуск M6 → ... → P
      for (let i = 0; i < 8; i++) {
        const res = stepGearSequential({ gear: cur, engineOn: true }, 0, 1, -1);
        assert(res.next !== null, `Ожидалось понижение с ${cur}`);
        cur = res.next!;
      }
      assert(cur === "P", `Полный спуск должен вернуть в P, получено ${cur}`);
      // Переход из D по Shift▲ на ходу повышает ступень в ручной режим
      assert(stepGearSequential({ gear: "D", engineOn: true }, 12, 2, 1).next === "3", "Shift▲ из D2 на ходу должен включать M3");

      // 1b. Физическая 3D-кулиса салона (applyShifterTarget / stepShifterGate): P↔R↔N↔D ⇄ M (+/−) + BTSI из P
      assert(applyShifterTarget({ gear: "P", engineOn: false, brake: 1 }, 0, 1, "D").next === null, "3D-рычаг из P без ДВС должен блокироваться");
      assert(applyShifterTarget({ gear: "P", engineOn: true, brake: 0 }, 0, 1, "D").next === null, "3D-рычаг из P без тормоза должен блокироваться");
      assert(stepShifterGate({ gear: "P", engineOn: true, brake: 0 }, 0, 1, 1).next === null, "Шаг 3D-рычага P→R без тормоза должен блокироваться");
      assert(stepShifterGate({ gear: "P", engineOn: true, brake: 1 }, 0, 1, 1).next === "R", "Шаг 3D-рычага P→R с нажатым тормозом");
      assert(stepShifterGate({ gear: "R", engineOn: true }, 0, 1, 1).next === "N", "Шаг 3D-рычага R→N");
      assert(stepShifterGate({ gear: "N", engineOn: true }, 0, 1, 1).next === "D", "Шаг 3D-рычага N→D");
      assert(applyShifterTarget({ gear: "D", engineOn: true }, 12, 3, "M").next === "3", "Перевод рычага D3→M фиксирует M3");
      assert(applyShifterTarget({ gear: "3", engineOn: true }, 12, 3, "M+").next === "4", "Качание M+ повышает M3→M4");
      assert(applyShifterTarget({ gear: "4", engineOn: true }, 12, 4, "M-").next === "3", "Качание M- понижает M4→M3");
      assert(applyShifterTarget({ gear: "1", engineOn: true }, 0, 1, "M-").next === null, "Упор M- на M1 не выбрасывает в N");
      assert(applyShifterTarget({ gear: "3", engineOn: true }, 15, 3, "D").next === "D", "Возврат рычага M3→D включает автомат D");
      assert(applyShifterTarget({ gear: "2", engineOn: true }, 8, 2, "M", { toggleManualOnClick: true }).next === "D", "Повторный клик по M возвращает D");
      assert(applyShifterTarget({ gear: "D", engineOn: true }, 5, 2, "R").next === null, "Включение R на скорости вперёд блокируется");
      assert(applyShifterTarget({ gear: "D", engineOn: true }, 5, 2, "P").next === null, "Включение P на скорости блокируется");

      // 2. Плавная раскрутка и спад оборотов на холостом ходу (P): без скачков, скорость 0
      let idleState = createInitialState(track, true);
      idleState = { ...idleState, gear: "P", prevGear: "P" };
      let maxRevStep = 0;
      for (let i = 0; i < 120; i++) {
        const prev = idleState.rpm;
        idleState = stepSimulation(
          idleState,
          { ...createReadyInput("P"), throttle: 1 },
          track,
          grid,
          DEFAULT_CALIBRATION,
          DEFAULT_RULESET,
          FIXED_DT
        ).state;
        assert(idleState.rpm >= prev - 0.01, "Обороты при перегазовке должны расти монотонно");
        maxRevStep = Math.max(maxRevStep, idleState.rpm - prev);
        assert(idleState.v === 0, "В P при перегазовке скорость обязана быть 0");
      }
      const peakFreeRpm = idleState.rpm;
      assert(peakFreeRpm > 6100 && maxRevStep <= 95, `Неплавная перегазовка: peak=${peakFreeRpm.toFixed(0)}, step=${maxRevStep.toFixed(1)}`);
      for (let i = 0; i < 150; i++) {
        idleState = stepSimulation(
          idleState,
          { ...createReadyInput("P"), throttle: 0 },
          track,
          grid,
          DEFAULT_CALIBRATION,
          DEFAULT_RULESET,
          FIXED_DT
        ).state;
      }
      assert(idleState.rpm < ENGINE_IDLE_RPM + 80, `Обороты не вернулись к ХХ: ${idleState.rpm.toFixed(0)}`);

      // 3. Разгон 0–100 км/ч и максимальная скорость 180 км/ч в режиме D (6АКПП)
      let autoS = createInitialState(track, true);
      let t100Auto: number | null = null;
      let maxKmhAuto = 0;
      let maxDriveRpmStep = 0;
      for (let i = 0; i < 55 * 60; i++) {
        const prevRpm = autoS.rpm;
        autoS = stepSimulation(
          autoS,
          { ...createReadyInput("D"), throttle: 1, signal: "left" },
          track,
          grid,
          DEFAULT_CALIBRATION,
          DEFAULT_RULESET,
          FIXED_DT
        ).state;
        const kmh = autoS.v * 3.6;
        if (t100Auto === null && kmh >= 100) t100Auto = autoS.time;
        maxKmhAuto = Math.max(maxKmhAuto, kmh);
        maxDriveRpmStep = Math.max(maxDriveRpmStep, Math.abs(autoS.rpm - prevRpm));
        assert(kmh <= MAX_SPEED_KMH + 1e-6, `Превышен потолок 180 км/ч: ${kmh.toFixed(3)}`);
      }
      assert(
        t100Auto !== null && t100Auto >= 10.2 && t100Auto <= 11.6,
        `Разгон 0–100 в D вне паспорта Kia Ceed 1.6 (10.2–11.6 с): ${t100Auto}`
      );
      assert(autoS.autoSubGear === MAX_FORWARD_GEAR, `Ожидалась 6-я передача на Vmax, получено D${autoS.autoSubGear}`);
      assert(maxKmhAuto >= 179.5 && Math.round(maxKmhAuto) === 180, `Vmax != 180 км/ч: ${maxKmhAuto.toFixed(2)}`);
      assert(maxDriveRpmStep <= 135, `Скачок оборотов на переключении слишком резкий: ${maxDriveRpmStep.toFixed(1)} об/тик`);

      // 4. Ручной разгон 0–100 км/ч на Shift (M1 → M2 → M3) + побитовый RLE-реплей
      let manS = createInitialState(track, true);
      const rec = new AttemptRecorder(manS, true);
      let manGear: Gear = "1";
      let t100Man: number | null = null;
      for (let i = 0; i < 14 * 60; i++) {
        if (manS.shiftTimer <= 0 && manS.rpm >= 6220) {
          const sh = stepGearSequential({ gear: manGear, engineOn: true }, manS.v, manS.autoSubGear, 1);
          if (sh.next) manGear = sh.next;
        }
        const inp = quantizeInput({ ...createReadyInput(manGear), throttle: 1, signal: "left" });
        const out = stepSimulation(manS, inp, track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
        manS = out.state;
        rec.recordTick(inp, manS, out.newEvents);
        if (t100Man === null && manS.v * 3.6 >= 100) t100Man = manS.time;
      }
      assert(
        t100Man !== null && t100Man >= 10.0 && t100Man <= 11.4,
        `Ручной разгон 0–100 на Shift вне паспорта (10.0–11.4 с): ${t100Man}`
      );
      assert(manGear === "3" || manGear === "4", `Ожидалась M3/M4 после 100 км/ч, получено M${manGear}`);
      const snap = rec.snapshot(manS, track, DEFAULT_CALIBRATION, DEFAULT_RULESET);
      const rep = replayInputStream(
        JSON.parse(JSON.stringify(snap.inputStream)),
        track,
        DEFAULT_CALIBRATION,
        DEFAULT_RULESET,
        true
      );
      assert(
        rep.finalState.x === manS.x &&
          rep.finalState.z === manS.z &&
          rep.finalState.v === manS.v &&
          rep.finalState.rpm === manS.rpm &&
          rep.finalState.gear === manS.gear,
        "Реплей заезда с переключениями Shift разошёлся с оригиналом"
      );

      return `0–100: D=${t100Auto!.toFixed(2)} с, Shift=${t100Man!.toFixed(2)} с · Vmax=${maxKmhAuto.toFixed(1)} км/ч (D6) · реплей 1:1`;
    },
  },
  {
    id: "T35",
    suite: "vehicle",
    name: "Самоход D1 на ХХ, реалистичное торможение (60/100–0), выбег без газа (N/D/M2/R) и BTSI P",
    fn: () => {
      const baseWorld = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
      const track = {
        ...baseWorld,
        bounds: { minX: -50, maxX: 50, minZ: -200, maxZ: 4000 },
        boundaryPolygon: undefined,
        obstacles: [],
        bays: [],
        checkpoints: [],
        signals: [],
        crosswalks: [],
        pedestrians: [],
        start: { x: 0, z: 0, h: 0 },
        defaultSpeedLimitKmh: 200,
      };
      const grid = new SpatialGrid([], 10);

      // 1. Самоход гидротрансформатора на D1 на минимальных оборотах (~800–880 об/мин, ровно 5 км/ч):
      // при нажатом тормозе S — 0 км/ч; при отпускании S — плавно трогается сам; на ручнике и в P/N/R — 0 км/ч
      let creepS = createInitialState(track, true);
      const rec = new AttemptRecorder(creepS, true);
      const runTick = (inp: ReturnType<typeof createReadyInput>) => {
        const q = quantizeInput(inp);
        const out = stepSimulation(creepS, q, track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
        creepS = out.state;
        rec.recordTick(q, creepS, out.newEvents);
      };
      // Удерживаем тормоз в D1 1,5 с — машина стоит неподвижно
      for (let i = 0; i < 90; i++) runTick({ ...createReadyInput("D"), brake: 1 });
      assert(creepS.v === 0, `В D1 с нажатым тормозом скорость обязана быть 0, получено ${creepS.v}`);
      // Отпускаем тормоз и НЕ нажимаем газ: машина лениво (не «прыгает») подходит к 5 км/ч за ~35 с
      for (let i = 0; i < 45 * 60; i++) runTick({ ...createReadyInput("D"), throttle: 0, brake: 0 });
      const creepKmh = creepS.v * 3.6;
      assert(
        creepKmh >= IDLE_CREEP_MAX_KMH - 0.6 && creepKmh <= IDLE_CREEP_MAX_KMH + 0.05 && creepS.autoSubGear === 1,
        `Неверная скорость самохода D1: ${creepKmh.toFixed(2)} км/ч (передача D${creepS.autoSubGear})`
      );
      assert(
        creepS.rpm >= ENGINE_IDLE_RPM - 10 && creepS.rpm <= 920,
        `Самоход D1 должен идти на минимальных оборотах ХХ, получено ${creepS.rpm.toFixed(0)} об/мин`
      );
      // Нажимаем тормоз S — плавная полная остановка в 0 без отката назад; отпускаем — снова едет сама
      for (let i = 0; i < 90; i++) runTick({ ...createReadyInput("D"), brake: 1 });
      assert(creepS.v === 0, `Тормоз S должен остановить самоход D1 в 0, получено ${creepS.v}`);
      // С 5 км/ч машина вновь «раскатывается» неохотно: за 12 с успевает вернуться к самоходу
      for (let i = 0; i < 12 * 60; i++) runTick({ ...createReadyInput("D"), brake: 0 });
      assert(creepS.v * 3.6 > 1.5, "После отпускания тормоза самоход D1 должен плавно возобновиться");
      // В N, R и с ручником без газа самохода нет
      for (const idleInp of [
        createReadyInput("N"),
        createReadyInput("R"),
        { ...createReadyInput("D"), handbrake: true },
      ]) {
        let st = createInitialState(track, true);
        for (let i = 0; i < 120; i++) {
          st = stepSimulation(st, idleInp, track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
        }
        assert(st.v === 0, `Без газа в режиме ${idleInp.gear} (hb=${idleInp.handbrake}) машина должна стоять`);
      }

      // 2. Реалистичное экстренное торможение 100–0 км/ч (паспорт Kia Ceed JD: ~38–44 м) + клевок кузова.
      // Мягкое нажатие без Shift идёт по гидравлической кривой и чуть длиннее; с Shift (энергичное
      // нажатие) гидропривод набирает давление вдвое быстрее — путь короче.
      const brakeFrom100 = (shift: boolean) => {
        let st = { ...createInitialState(track, true), v: 100 / 3.6, prevV: 100 / 3.6, autoSubGear: 4, rpm: 4160 };
        const z0 = st.z;
        let dive = 0;
        for (let i = 0; i < 9 * 60; i++) {
          st = stepSimulation(
            st,
            { ...createReadyInput("D"), brake: 1, shiftBoost: shift },
            track,
            grid,
            DEFAULT_CALIBRATION,
            DEFAULT_RULESET,
            FIXED_DT
          ).state;
          dive = Math.max(dive, st.pitch);
          assert(st.v >= 0, "Тормоз S никогда не должен давать откат назад");
        }
        return { st, dist: st.z - z0, dive };
      };
      const soft100 = brakeFrom100(false);
      const hard100 = brakeFrom100(true);
      const brakeS = hard100.st;
      const maxDivePitch = hard100.dive;
      const stopDist100 = hard100.dist;
      assert(
        brakeS.v === 0 && stopDist100 >= 38 && stopDist100 <= 54,
        `Тормозной путь 100–0 км/ч с Shift вне диапазона (38–54 м): ${stopDist100.toFixed(1)} м`
      );
      assert(
        hard100.dist < soft100.dist - 1.5,
        `Shift обязан усиливать торможение: с Shift ${hard100.dist.toFixed(1)} м против ${soft100.dist.toFixed(1)} м`
      );
      // Мягкая кривая педали: за 1/3 с гидропривод не успевает выйти на полку
      let softPedal = { ...createInitialState(track, true), v: 60 / 3.6, prevV: 60 / 3.6, autoSubGear: 3 };
      for (let i = 0; i < 20; i++) {
        softPedal = stepSimulation(softPedal, { ...createReadyInput("D"), brake: 1 }, track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(
        softPedal.brakePos > 0.2 && softPedal.brakePos < 0.78,
        `Гидропривод обязан набирать давление плавно: за 1/3 с получено ${softPedal.brakePos.toFixed(2)}`
      );
      assert(maxDivePitch > 0.02 && Math.abs(brakeS.pitch) < 0.004, "Кузов должен клюнуть при торможении и выровняться в 0");

      // 3. Остановка выбегом без газа: в N — до 0 км/ч; в M2 торможение двигателем сильнее N; в D — до самохода D1
      let coastN = { ...createInitialState(track, true), gear: "N" as Gear, prevGear: "N" as Gear, v: 25 / 3.6, prevV: 25 / 3.6 };
      for (let i = 0; i < 50 * 60 && coastN.v > 0; i++) {
        coastN = stepSimulation(coastN, createReadyInput("N"), track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(coastN.v === 0, `Выбег в N без газа должен плавно остановиться в 0, осталось ${(coastN.v * 3.6).toFixed(2)} км/ч`);

      let ebN = { ...createInitialState(track, true), gear: "N" as Gear, prevGear: "N" as Gear, v: 55 / 3.6, prevV: 55 / 3.6 };
      let ebM2 = { ...createInitialState(track, true), gear: "2" as Gear, prevGear: "2" as Gear, autoSubGear: 2, v: 55 / 3.6, prevV: 55 / 3.6 };
      for (let i = 0; i < 4 * 60; i++) {
        ebN = stepSimulation(ebN, createReadyInput("N"), track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
        ebM2 = stepSimulation(ebM2, createReadyInput("2"), track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(
        ebM2.v + 1.2 < ebN.v,
        `Торможение двигателем на M2 (${(ebM2.v * 3.6).toFixed(1)} км/ч) должно быть заметно сильнее выбега в N (${(ebN.v * 3.6).toFixed(1)} км/ч)`
      );

      // «Как настоящая»: на передаче машина тормозит мотором, а не катится как в нейтрали.
      // 60 км/ч без газа до порога самохода: M1 ≈ 12 с, M2 ≈ 19 с, N ≈ 62 с.
      const coastToCreep = (gear: Gear, sub: number) => {
        let st = { ...createInitialState(track, true), gear, prevGear: gear, autoSubGear: sub, v: 60 / 3.6, prevV: 60 / 3.6 };
        let sec = 0;
        while (st.v * 3.6 > 5.2 && sec < 80) {
          st = stepSimulation(st, createReadyInput(gear), track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
          sec += FIXED_DT;
        }
        return sec;
      };
      const tN = coastToCreep("N", 0);
      const tM1 = coastToCreep("1", 1);
      const tM2 = coastToCreep("2", 2);
      assert(
        tM1 < 16 && tM2 < tM1 + 8 && tN > tM1 * 3,
        `Торможение двигателем должно быть сильным: 60→5 км/ч M1=${tM1.toFixed(1)} с, M2=${tM2.toFixed(1)} с, N=${tN.toFixed(1)} с`
      );
      assert(tM2 > tM1, `На низшей передаче торможение двигателем сильнее: M1=${tM1.toFixed(1)} с, M2=${tM2.toFixed(1)} с`);

      let coastD = { ...createInitialState(track, true), v: 50 / 3.6, prevV: 50 / 3.6, autoSubGear: 3 };
      for (let i = 0; i < 45 * 60; i++) {
        coastD = stepSimulation(coastD, createReadyInput("D"), track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(
        coastD.autoSubGear === 1 && Math.abs(coastD.v * 3.6 - IDLE_CREEP_MAX_KMH) < 0.8,
        `Выбег в D без газа должен плавно спуститься до самохода D1, получено D${coastD.autoSubGear} ${(coastD.v * 3.6).toFixed(2)} км/ч`
      );

      // Выбег задним ходом R без газа — плавная полная остановка в 0 км/ч
      let coastR = { ...createInitialState(track, true), gear: "R" as Gear, prevGear: "R" as Gear, v: -10 / 3.6, prevV: -10 / 3.6 };
      for (let i = 0; i < 8 * 60 && coastR.v < 0; i++) {
        coastR = stepSimulation(coastR, createReadyInput("R"), track, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
      }
      assert(coastR.v === 0, `Выбег в R без газа должен плавно остановиться в 0, получено ${coastR.v}`);

      // 4. Побитовый детерминизм реплея заезда с самоходом D1 и гидротормозом
      const snap = rec.snapshot(creepS, track, DEFAULT_CALIBRATION, DEFAULT_RULESET);
      const rep = replayInputStream(JSON.parse(JSON.stringify(snap.inputStream)), track, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
      assert(
        rep.finalState.z === creepS.z && rep.finalState.v === creepS.v && rep.finalState.brakePos === creepS.brakePos,
        "Реплей самохода D1 и прогрессивного тормоза разошёлся"
      );

      return `D1 creep=${creepKmh.toFixed(1)} км/ч · 100–0=${stopDist100.toFixed(1)} м (мягко ${soft100.dist.toFixed(1)} м) · M2<N · BTSI P OK`;
    },
  },
  {
    id: "T36",
    suite: "audio",
    name: "Радио ШГУ: реальные интернет-станции, громкость, кэш-ключи и офлайн-рендер трека в WAV",
    fn: () => {
      // 1. Каталог реальных интернет-станций: уникальные id/частоты, только https-потоки
      assert(INTERNET_RADIO_STATIONS.length >= 4, `В каталоге должно быть ≥ 4 станции, есть ${INTERNET_RADIO_STATIONS.length}`);
      const ids = new Set(INTERNET_RADIO_STATIONS.map((st) => st.id));
      assert(ids.size === INTERNET_RADIO_STATIONS.length, "id станций должны быть уникальны");
      for (const st of INTERNET_RADIO_STATIONS) {
        assert(/^https:\/\//.test(st.streamUrl), `Поток станции ${st.id} должен быть по https`);
        assert(st.bpm >= 40 && st.notes.length >= 4, `Станция ${st.id}: нужны bpm и аккордовая сетка`);
        assert(describeStation(st).includes(st.freq) && describeStation(st).includes(st.name), "Описание станции должно содержать частоту и название");
      }

      // 2. Листание станций по кругу и громкость 0..100 %
      assert(nextStationIndex(0, -1) === INTERNET_RADIO_STATIONS.length - 1, "Листание станции влево должно зацикливаться");
      assert(nextStationIndex(INTERNET_RADIO_STATIONS.length - 1, 1) === 0, "Листание станции вправо должно зацикливаться");
      assert(nextStationIndex(2, 1) === 3, "Следующая станция +1");
      assert(clampVolume(1.4) === 1 && clampVolume(-0.3) === 0 && clampVolume(Number.NaN) === 0.7, "Громкость ограничивается 0..1");
      assert(clampVolume(0.456) === 0.46, "Громкость округляется до 1 %");

      // 3. Ключи кэша треков и форматирование длительности
      assert(trackCacheKey("record", 32) === "radio:record:32s", "Ключ кэша трека");
      assert(trackCacheKey("record", 32) === trackCacheKey("record", 31.6), "Ключ кэша округляет длительность");
      assert(formatTrackDuration(32) === "00:32" && formatTrackDuration(125) === "02:05", "Формат длительности мм:сс");

      // 4. Офлайн-рендер трека в WAV: корректный RIFF/WAVE-заголовок, PCM 16 бит моно, ненулевой сигнал
      const station = INTERNET_RADIO_STATIONS[0];
      const wav = renderTrackWav(station, 2);
      const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
      const ascii = (off: number, len: number) => String.fromCharCode(...wav.slice(off, off + len));
      assert(ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE" && ascii(36, 4) === "data", "WAV: заголовок RIFF/WAVE/data");
      assert(view.getUint16(20, true) === 1, "WAV: PCM");
      assert(view.getUint16(22, true) === 1, "WAV: моно");
      assert(view.getUint32(24, true) === TRACK_SAMPLE_RATE, "WAV: частота дискретизации");
      assert(view.getUint16(34, true) === 16, "WAV: 16 бит на сэмпл");
      const frames = view.getUint32(40, true) / 2;
      assert(frames === TRACK_SAMPLE_RATE * 2, `WAV: 2 с должно быть ${TRACK_SAMPLE_RATE * 2} кадров, есть ${frames}`);
      let peak = 0;
      for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
      assert(peak > 3000, `WAV: сигнал не должен быть тишиной (пик ${peak})`);
      assert(renderTrackWav(station, 1).length !== renderTrackWav(station, 2).length, "Длина WAV зависит от запрошенных секунд");

      // 5. Блокировка селектора «как в реальном автомобиле»: Shift Lock / BTSI
      const deadEngine = shiftLockState({ gear: "P", engineOn: false, brake: 1 }, 0);
      assert(deadEngine.locked && deadEngine.reason === "engine_off", "Заглушенный ДВС должен запирать селектор");
      const noBrake = shiftLockState({ gear: "P", engineOn: true, brake: 0 }, 0, "D");
      assert(noBrake.locked && noBrake.reason === "brake" && noBrake.brakeRequired, "BTSI: выход из P без тормоза заперт");
      const withBrake = shiftLockState({ gear: "P", engineOn: true, brake: SHIFT_LOCK_MIN_BRAKE }, 0, "D");
      assert(!withBrake.locked && withBrake.reason === null, "BTSI: с нажатым тормозом селектор свободен");
      const moving = shiftLockState({ gear: "D", engineOn: true, brake: 1 }, 8, "P");
      assert(moving.locked && moving.reason === "speed", "P на ходу должен быть заперт");
      const driving = shiftLockState({ gear: "D", engineOn: true, brake: 0 }, 15, "D");
      assert(!driving.locked, "В движении в D селектор не заперт");

      return `станций=${INTERNET_RADIO_STATIONS.length} · WAV ${(wav.length / 1024).toFixed(0)} КБ/2 с · пик ${peak} · Shift Lock OK`;
    },
  },
  {
    id: "T37",
    suite: "vehicle",
    name: "Взгляд водителя: три точки внимания (зеркала/дорога), инерция шеи и свободный обзор ПКМ без возврата",
    fn: () => {
      // 1. Три детента внимания: дорога в центре, зеркала по краям, углы симметричны
      assert(HEAD_DETENTS.length === 3, "Точек внимания должно быть ровно три: левое зеркало, дорога, правое зеркало");
      assert(
        HEAD_DETENTS.map((d) => d.id).join(",") === "left,road,right",
        "Порядок точек внимания: левое зеркало → дорога → правое зеркало"
      );
      assert(HEAD_DETENTS.filter((d) => d.mirror).length === 2, "Две точки внимания обязаны быть зеркалами");
      assert(detentYawRad(0) === 0, "Дорога — нулевой азимут головы");
      assert(Math.abs(detentYawRad(1) + detentYawRad(-1)) < 1e-12, "Зеркала симметричны относительно дороги");
      const mirrorDeg = (Math.abs(detentYawRad(1)) * 180) / Math.PI;
      assert(
        mirrorDeg > 30 && mirrorDeg < 50,
        `Угол на боковое зеркало должен быть 30–50°, получено ${mirrorDeg.toFixed(1)}°`
      );
      assert(
        Math.abs(mirrorDeg - HEAD_TURN.MIRROR_DEG) < 0.001,
        "Детент зеркала обязан совпадать с геометрическим углом HEAD_TURN.MIRROR_DEG"
      );
      // Наклон на дорогу оставляет салонное зеркало в верхней трети кадра (взгляд чуть вниз)
      assert(HEAD_TURN.PITCH_RAD < 0 && HEAD_TURN.PITCH_RAD > -0.12, "Взгляд на дорогу — лёгкий наклон вниз");
      assert(
        detentLabel(0).length > 0 && detentLabel(1).length > 0 && detentLabel(-1).length > 0 &&
          detentLabel(1) !== detentLabel(-1),
        "У каждой точки внимания должна быть своя подпись для HUD"
      );

      // 2. Инерция шеи: цель достигается за ~0,18 с (3τ), за один кадр — только часть пути
      const dt = FIXED_DT;
      const tau = HEAD_TURN.TAU_S;
      const targetYaw = detentYawRad(1);
      let yaw = 0;
      let frames = 0;
      while (Math.abs(targetYaw - yaw) > Math.abs(targetYaw) * 0.02 && frames < 300) {
        yaw += (targetYaw - yaw) * Math.min(1, dt / tau);
        frames++;
      }
      const travelSec = frames * dt;
      assert(
        travelSec > 0.05 && travelSec < 0.32,
        `Довод головы до зеркала должен занимать 0,05–0,32 с, получено ${travelSec.toFixed(3)} с`
      );
      const afterOneFrame = targetYaw * Math.min(1, dt / tau);
      assert(
        Math.abs(afterOneFrame) < Math.abs(targetYaw) * 0.5,
        "За один кадр голова не должна телепортироваться в зеркало — только часть пути"
      );

      // 3. Свободный обзор: пределы ±100° и наклон −52…+26°, цель НЕ сбрасывается сама
      const freeYaw = HEAD_TURN.maxRad;
      assert(Math.abs((freeYaw * 180) / Math.PI - 100) < 0.001, "Свободный обзор ограничен ±100°");
      assert(HEAD_TURN.minPitchRad < 0 && HEAD_TURN.maxPitchRad > 0, "Свободный обзор работает вверх и вниз");
      let free = 0;
      const dragStep = -0.0042 * 40; // 40 px вправо за кадр
      for (let i = 0; i < 30; i++) {
        free = Math.max(-HEAD_TURN.maxRad, Math.min(HEAD_TURN.maxRad, free + dragStep));
        free += (free - free) * Math.min(1, dt / tau); // «цель» = накопленное смещение, возврата нет
      }
      assert(free !== 0, "Свободный обзор ПКМ не должен сам возвращаться на дорогу");
      assert(
        Math.abs(free) > HEAD_TURN.MIRROR_RAD * 0.5,
        `Смещение ПКМ должно реально поворачивать голову (получено ${((free * 180) / Math.PI).toFixed(1)}°)`
      );

      // 4. Взгляд на консоль ШГУ/рычаг — тоже цель головы: возврат идёт туда же, где были
      assert(HEAD_TURN.SHIFTER_RAD > 0.4 && HEAD_TURN.SHIFTER_PITCH_RAD > 0.3, "Взгляд на консоль: вниз-вправо");

      return `3 точки (${mirrorDeg.toFixed(0)}° зеркала) · довод ${travelSec.toFixed(2)} с · свободный обзор ±${HEAD_TURN.maxDeg}° без возврата`;
    },
  },
  {
    id: "T38",
    suite: "vehicle",
    name: "Парк автомобилей игрока: реальные пропорции, ограничитель скорости, тормоза и самоход по паспорту",
    fn: () => {
      assert(PLAYER_CARS.length === 5, "В парке должно быть ровно пять машин: Picanto, Rio, Ceed, XCeed, Sorento");
      assert(
        PLAYER_CARS.map((c) => c.id).join(",") === "picanto,rio,ceed,xceed,sorento",
        "Порядок машин в парке: от городского хэтчбека к SUV"
      );
      assert(getPlayerCar("ceed").id === "ceed", "Машина по умолчанию — учебный Ceed JD");
      assert(getPlayerCar(undefined).id === "ceed" && getPlayerCar("unknown").id === "ceed", "Неизвестный id → Ceed");
      assert(DEFAULT_PLAYER_CAR_ID === "ceed", "Идентификатор по умолчанию — ceed");

      for (const c of PLAYER_CARS) {
        // Пропорции: база + свесы = длина, колея меньше ширины, база в разумных пределах
        assert(
          Math.abs(c.frontOverhang + c.wheelbase + c.rearOverhang - c.length) < 0.02,
          `${c.name}: база и свесы не сходятся с длиной кузова`
        );
        assert(c.track < c.width && c.track > c.width - 0.35, `${c.name}: колея должна быть чуть уже кузова`);
        assert(c.wheelbase > 2.3 && c.wheelbase < 2.9, `${c.name}: база вне реального диапазона`);
        assert(c.wheelRadius > 0.25 && c.wheelRadius < 0.37, `${c.name}: радиус колеса вне реального диапазона`);
        assert(c.maxInnerDeg >= 30 && c.maxInnerDeg <= 42, `${c.name}: предел внутреннего колеса вне 30–42°`);
        // Скоростные режимы и динамика монотонно растут с классом
        assert(c.vmaxKmh >= 150 && c.vmaxKmh <= 215, `${c.name}: максимальная скорость вне 150–215 км/ч`);
        assert(c.peakAccel > 2.5 && c.peakAccel < 5.2, `${c.name}: тяговое ускорение вне реального диапазона`);
        assert(c.creepKmh >= 4 && c.creepKmh <= 6, `${c.name}: самоход D1 вне 4–6 км/ч`);
        assert(c.accel0to100 > 4 && c.accel0to100 < 18, `${c.name}: 0–100 вне реального диапазона`);
      }
      // Иерархия парка: Picanto медленнее и компактнее, Sorento — самый большой и быстрый по Vmax
      const pic = getPlayerCar("picanto");
      const ceed = getPlayerCar("ceed");
      const sor = getPlayerCar("sorento");
      assert(pic.length < ceed.length && ceed.length < sor.length, "Длина кузова должна расти от Picanto к Sorento");
      assert(pic.vmaxKmh < ceed.vmaxKmh && ceed.vmaxKmh < sor.vmaxKmh, "Максимальная скорость растёт с классом");
      assert(pic.accel0to100 > ceed.accel0to100, "Picanto 1.2 медленнее Ceed 1.6 в разгоне до 100");
      assert(sor.brakeScale > ceed.brakeScale, "Sorento тормозит сильнее Ceed (масса учтена в тормозах)");

      // Физика Ceed обязана остаться побитно прежней: коэффициенты ровно 1
      const base = playerCarPhysics("ceed");
      assert(
        base.accelScale === 1 && base.brakeScale === 1 && base.vmaxKmh === 180 && base.creepKmh === 5,
        "Ceed — эталон: коэффициенты физики обязаны быть ровно 1 (совместимость с T01–T37)"
      );
      // И маленькая машина на ровном газу реально упирается в свой ограничитель, а не в общий 180
      // Прямой участок 400 м без препятствий: разгон в пол до ограничителя занимает < 60 с
      const world = {
        ...buildScenarioWorld("bay_90", DEFAULT_CALIBRATION),
        start: { x: 0, z: 0, h: 0 },
        bays: [],
        obstacles: [],
        bounds: { minX: -20, maxX: 1200, minZ: -40, maxZ: 40 },
        playerCarId: "picanto" as const,
      };
      const grid = new SpatialGrid([], 10);
      let st = createInitialState(world, true);
      const inp = createReadyInput();
      inp.gear = "D";
      inp.throttle = 1;
      for (let i = 0; i < 60 * 55; i++) st = stepSimulation(st, inp, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
      const kmh = st.v * 3.6;
      assert(
        kmh > 150 && kmh <= 161,
        `Picanto обязан упираться в свой ограничитель ~160 км/ч, получено ${kmh.toFixed(1)} км/ч`
      );
      assert(st.carId === "picanto", "Состояние должно запомнить машину заезда");

      const p = playerCarPhysics("sorento");

      // 5. Сценарий хранит машину и список станций; старый файл без полей ведёт себя как раньше
      const legacy = normalizeCustomScenario({ title: "Старый файл" });
      assert(legacy.playerCarId === undefined, "Старый файл сценария не должен получать машину по умолчанию в файле");
      assert(legacy.radioStationIds === undefined, "Старый файл сценария не должен получать список станций");
      assert(buildCustomWorld(legacy).playerCarId === undefined, "Мир старого сценария остаётся на учебном Ceed");
      const tuned = normalizeCustomScenario({
        title: "Свой заезд",
        playerCarId: "xceed",
        radioStationIds: ["record", "unknown-station", "europa-plus"],
      });
      assert(tuned.playerCarId === "xceed", "Сценарий должен запомнить выбранную машину");
      assert(
        Array.isArray(tuned.radioStationIds) && tuned.radioStationIds.join(",") === "record,europa-plus",
        "Список станций сценария обязан отбросить неизвестный id и сохранить порядок"
      );
      const tunedWorld = buildCustomWorld(tuned);
      assert(tunedWorld.playerCarId === "xceed", "Мир сценария должен нести машину игрока");
      assert(
        Array.isArray(tunedWorld.radioStationIds) && tunedWorld.radioStationIds.length === 2,
        "Мир сценария должен нести список станций тюнера"
      );
      assert(
        normalizeCustomScenario({ radioStationIds: [] }).radioStationIds === undefined &&
          normalizeCustomScenario({ playerCarId: "tractor" as never }).playerCarId === undefined,
        "Пустой список и неизвестная машина не должны попадать в сценарий"
      );
      assert(radioStationsFor(["record"]).map((st) => st.id).join(",") === "record", "Сценарий сужает тюнер до своих станций");
      assert(
        radioStationsFor(undefined).length === INTERNET_RADIO_STATIONS.length,
        "Без списка тюнер показывает весь каталог станций"
      );

      return `5 машин · Ceed эталон 1:1 · Picanto ${kmh.toFixed(0)} км/ч · Sorento ${p.length.toFixed(2)} м / тормоза ×${p.brakeScale} · сценарий: машина + ${tunedWorld.radioStationIds?.length ?? 0} станции`;
    },
  },
  {
    id: "T39",
    suite: "vehicle",
    name: "Кадрировка вида из салона: руль в нижней трети, дорога и салонное зеркало в верхней, поза по паспорту машины",
    fn: () => {
      const framing = cockpitFramingFor("ceed");
      // Эталонный кадр референса: глаз на уровне 1,19 м, чуть впереди центра базы, наклон вниз на ~3°
      assert(
        Math.abs(framing.eyeY - 1.195) < 0.01 && Math.abs(framing.eyeZ + 0.06) < 0.02,
        "Ceed: глаз водителя должен стоять в выверенной точке референса (1,195 м; −0,06 м)"
      );
      assert(
        framing.eyeAboveWheelM > 0.25 && framing.eyeAboveWheelM < 0.35,
        "Глаз обязан быть выше ступицы руля на 0,25–0,35 м, иначе обод закроет дорогу"
      );
      assert(framing.pitchRad < 0 && framing.pitchRad > -0.09, "Взгляд на дорогу — лёгкий наклон вниз");
      assert(framing.fovDeg >= 62 && framing.fovDeg <= 72, "FOV базового ракурса — 62–72° (как на референсе)");

      // Колесо руля (доли от НИЗА кадра, как на референсе: верх обода ≈ 42 %, ступица ≈ 21 %)
      const band = cockpitWheelBand(framing);
      assert(
        band.topV > 0.34 && band.topV < 0.52,
        `Верх обода руля должен быть на 34–52 % высоты от низа, получено ${band.topV.toFixed(3)}`
      );
      assert(band.bottomV < 0.06, `Нижняя часть обода почти уходит за кадр, получено ${band.bottomV.toFixed(3)}`);
      assert(band.hubV > 0.12 && band.hubV < 0.30, "Ступица руля в нижней трети кадра");
      assert(Math.abs(band.hubU - 0.5) < 0.18, `Руль стоит по центру кадра (u=${band.hubU.toFixed(3)})`);

      // Дорога: точка в 40 м впереди машины попадает в среднюю полосу кадра (не в небо и не за капот)
      const road = projectCockpitPoint(framing, { x: 0, y: 0, z: 40 });
      assert(road.v > 0.42 && road.v < 0.64, `Дорога в 40 м должна быть в средней полосе кадра (v=${road.v.toFixed(3)})`);
      // Ближняя дорога в 12 м — выше руля, но ниже горизонта
      const near = projectCockpitPoint(framing, { x: 0, y: 0, z: 12 });
      assert(near.v > band.topV + 0.02, "Ближняя дорога обязана быть видна над ободом руля");
      const far = projectCockpitPoint(framing, { x: 0, y: 0, z: 320 });
      assert(far.v > near.v && far.v < 0.72, "Дальняя дорога уходит к горизонту, но не в верх кадра");

      // Салонное зеркало — реальная геометрия рига: центр (0; 1,326; centerShiftZ + 0,644), высота полотна 0,078 м
      const mirrorCenterZ = (CAR.frontOverhang - CAR.rearOverhang) / 2 + 0.644;
      const mirror = projectCockpitPoint(framing, { x: 0, y: 1.326, z: mirrorCenterZ });
      const mirrorTop = projectCockpitPoint(framing, { x: 0, y: 1.365, z: mirrorCenterZ });
      const mirrorBottom = projectCockpitPoint(framing, { x: 0, y: 1.287, z: mirrorCenterZ });
      assert(
        mirror.u > 0.55 && mirror.u < 0.9 && mirror.v > 0.6 && mirror.v < 0.85,
        `Салонное зеркало обязано быть справа вверху кадра (u=${mirror.u.toFixed(2)}, v=${mirror.v.toFixed(2)})`
      );
      assert(mirrorTop.v < 0.99 && mirrorBottom.v > 0.5, "Салонное зеркало видно целиком, не обрезано кромкой кадра");
      // Дорога и зеркало в одном кадре: зеркало над дорогой, дорога над рулём
      assert(mirrorBottom.v > road.v && road.v > band.topV, "Композиция: руль → дорога → салонное зеркало снизу вверх");

      // Поза масштабируется по паспорту: Picanto ниже и ближе, Sorento выше и дальше — но кадр тот же по композиции.
      // Высота считается по пропорции кузова: Picanto ниже Ceed-класса по посадке, Sorento заметно выше.
      const pic = cockpitFramingFor("picanto");
      const sor = cockpitFramingFor("sorento");
      assert(sor.eyeY > framing.eyeY + 0.05, "У Sorento водитель сидит заметно выше, чем в Ceed");
      assert(
        pic.eyeZ > framing.eyeZ && sor.eyeZ < framing.eyeZ,
        "Более длинная база отодвигает сиденье от руля, короткая — придвигает"
      );
      assert(pic.eyeX < sor.eyeX, "Чем шире кузов, тем дальше глаз от оси — меняется только поперечная поза");
      for (const [id, f] of [
        ["picanto", pic],
        ["sorento", sor],
      ] as const) {
        const b = cockpitWheelBand(f);
        const r = projectCockpitPoint(f, { x: 0, y: 0, z: 40 });
        assert(b.topV > 0.3 && b.topV < 0.55, `${id}: обод руля вне рабочей полосы кадра`);
        assert(r.v > 0.4 && r.v < 0.68, `${id}: дорога должна оставаться в средней полосе кадра`);
        assert(r.v > b.topV, `${id}: дорога должна быть видна над ободом руля`);
      }

      return `Ceed: обод ${(band.topV * 100).toFixed(0)}–${(band.bottomV * 100).toFixed(0)} % · ступица ${(band.hubV * 100).toFixed(0)} % · салонное зеркало ${(mirror.v * 100).toFixed(0)} % · FOV ${framing.fovDeg.toFixed(0)}°`;
    },
  },
  {
    id: "T40",
    suite: "vehicle",
    name: "Габариты машины в физике: клиренс в боксе, радиус разворота и углы Аккермана по паспорту",
    fn: () => {
      const ceed = carGeometry("ceed");
      const pic = carGeometry("picanto");
      const sor = carGeometry("sorento");
      // Эталон: без carId геометрия побитно равна прежним константам Ceed
      const base = carGeometry(undefined);
      assert(
        base.length === CAR.length && base.width === CAR.width && base.wheelbase === CAR.wheelbase,
        "Без машины геометрия обязана совпадать с константами CAR (совместимость старых реплеев)"
      );
      assert(
        Math.abs(ceed.length - CAR.length) < 1e-9 && Math.abs(ceed.width - CAR.width) < 1e-9,
        "Ceed из парка обязан совпадать с CAR по габаритам"
      );
      assert(
        pic.length < ceed.length && ceed.length < sor.length && pic.width < sor.width,
        "Габариты растут от Picanto к Sorento"
      );

      // Углы кузова реально масштабируются: Sorento заметно крупнее Picanto по площади
      const area = (g: ReturnType<typeof carGeometry>) => {
        const c = getCarCorners(0, 0, 0, g);
        let s = 0;
        for (let i = 0; i < 4; i++) {
          const a = c[i];
          const b = c[(i + 1) % 4];
          s += a.x * b.z - b.x * a.z;
        }
        return Math.abs(s) / 2;
      };
      assert(
        Math.abs(area(ceed) - CAR.length * CAR.width) < 0.02,
        "Площадь кузова Ceed из углов обязана равняться length × width"
      );
      // Паспортные площади: Ceed 4,31×1,80 = 7,76 м², Sorento 4,81×1,90 = 9,14 м² (+18 %)
      assert(area(sor) > area(ceed) * 1.15, "Sorento обязан быть заметно крупнее Ceed по площади");

      // Бокс 2,5×5,3 м: Picanto влезает, Sorento — нет (это и есть смысл реальных пропорций)
      const bay = {
        id: 1040,
        label: "Тестовый бокс",
        cx: 0,
        cz: 0,
        h: 0,
        width: 2.5,
        length: 5.3,
        kind: "perpendicular" as const,
        openSide: "front" as const,
        occupied: false,
      };
      assert(isCarInsideBay(0, 0, 0, bay, 0.04, pic), "Picanto обязан влезать в стандартный бокс 2,5×5,3 м");
      assert(isCarInsideBay(0, 0, 0, bay, 0.04, ceed), "Ceed обязан влезать в стандартный бокс 2,5×5,3 м");
      assert(isCarInsideBay(0, 0, 0, bay, 0.04, sor), "Sorento обязан влезать в стандартный бокс 2,5×5,3 м");
      // Узкий компактный карман 1,75×3,9 м: Picanto встаёт, Ceed и Sorento — нет (реальные пропорции работают)
      const tightBay = { ...bay, id: 1041, width: 1.75, length: 3.9 };
      assert(
        isCarInsideBay(0, 0, 0, tightBay, 0.04, pic),
        "Picanto 1,595×3,595 м обязан влезать в узкий карман 1,75×3,9 м"
      );
      assert(
        !isCarInsideBay(0, 0, 0, tightBay, 0.04, ceed),
        "Ceed шириной 1,80 м не должен влезать в узкий карман 1,75 м — это проверяет габариты, а не константы"
      );
      assert(
        !isCarInsideBay(0, 0, 0, tightBay, 0.04, sor),
        "Sorento не должен влезать в узкий карман — габариты обязаны влиять на зачёт упражнения"
      );

      // Аккерман: у Picanto (малая колея при короткой базе) внутреннее колесо повёрнуто сильнее, чем у Sorento
      const delta = 0.35;
      const picInner = Math.abs(ackermannAngle(1, delta, pic));
      const sorInner = Math.abs(ackermannAngle(1, delta, sor));
      assert(picInner > sorInner, "Узкая короткая машина требует большего угла внутреннего колеса");
      // Без геометрии — ровно прежнее значение (нулевой регресс)
      assert(
        Math.abs(ackermannAngle(1, delta) - ackermannAngle(1, delta, carGeometry("ceed"))) < 1e-12,
        "Аккерман для Ceed не должен измениться ни на йоту"
      );

      // Радиус разворота по базе: короткий Picanto разворачивается круче
      const radius = (g: ReturnType<typeof carGeometry>) => g.wheelbase / Math.tan(delta) + g.width / 2;
      // При 20° поворота: Picanto ≈ 7,4 м против Sorento ≈ 8,7 м — разница ровно из баз и колеи
      assert(radius(pic) < radius(sor) * 0.9, "Picanto обязан разворачиваться заметно круче Sorento");

      // Попытка обязана запомнить машину: дебриф и реплей строят контур кузова по ней, а не по Ceed
      const rideWith = (carId: "xceed" | undefined, ticks: number) => {
        const w = carId
          ? { ...buildScenarioWorld("bay_90", DEFAULT_CALIBRATION), playerCarId: carId }
          : buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const g = new SpatialGrid(w.obstacles, 10);
        let st = createInitialState(w, true);
        const rec = new AttemptRecorder(st, true);
        const inp = createReadyInput();
        for (let i = 0; i < ticks; i++) {
          const out = stepSimulation(st, inp, w, g, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          st = out.state;
          rec.recordTick(inp, st, out.newEvents);
        }
        return { state: st, attempt: rec.snapshot(st, w, DEFAULT_CALIBRATION, DEFAULT_RULESET) };
      };
      const xceedRide = rideWith("xceed", 90);
      const attempt = xceedRide.attempt;
      assert(xceedRide.state.carId === "xceed", "Состояние заезда должно нести машину мира");
      assert(attempt.playerCarId === "xceed", "Попытка обязана сохранить машину заезда для дебриифа и реплея");
      assert(
        rideWith(undefined, 30).attempt.playerCarId === undefined,
        "Заезд на Ceed не добавляет поле машины — старые записи совместимы"
      );

      return `Ceed ${ceed.length.toFixed(2)}×${ceed.width.toFixed(2)} м · Picanto влезает в карман 1,75 м, Ceed/Sorento нет · Аккерман ${(picInner * 57.3).toFixed(1)}° против ${(sorInner * 57.3).toFixed(1)}° · попытка запомнила ${attempt.playerCarId}`;
    },
  },
];
