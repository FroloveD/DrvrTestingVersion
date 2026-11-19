/**
 * @module sim/selfTestExtra
 * @layer pure-core
 * @role Расширенный набор автотестов ядра: USB-руль (T17), журнал и ДИ Уилсона (T19), реплей (T22, T24), выворот (T23), КПП/Shift/динамика (T25, T34), Markdown (T26), OSM/границы/маршруты/редактор (T27–T33).
 * @invariants #7 (чистое ядро без DOM и Three.js).
 */
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
import { checkEngineToggle, checkGearChange, PARK_LOCK_MAX_SPEED_MS, stepGearSequential } from "./controls";
import { joinAttempt, splitAttempt, upsertJournal, upsertReview, type AttemptMeta } from "./journal";
import { AttemptRecorder, quantizeInput, replayInputStream, type RecordedAttempt } from "./recorder";
import { SpatialGrid } from "./spatialGrid";
import { createInitialState, createReadyInput, getActiveSpeedLimit, stepSimulation } from "./step";
import type { Gear, SimEvent } from "./types";
import {
  ackermannAngle,
  CAR,
  centralSteerLimit,
  clamp,
  ENGINE_IDLE_RPM,
  FIXED_DT,
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
      assert(checkGearChange({ gear: "P", engineOn: false }, 0, "D") !== null, "Выход из P без ДВС должен блокироваться");
      assert(checkGearChange({ gear: "P", engineOn: false }, 0, "R") !== null, "Переход P → R без ДВС должен блокироваться");
      assert(checkGearChange({ gear: "P", engineOn: true }, 0, "D") === null, "Выход из P с запущенным ДВС разрешён");
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

      // 1. Секвентальное переключение Shift (P ↔ R ↔ N ↔ M1..M6) и защитные блокировки
      assert(stepGearSequential({ gear: "P", engineOn: false }, 0, 1, 1).next === null, "Shift из P без ДВС должен блокироваться");
      const upSeq: Gear[] = [];
      let cur: Gear = "P";
      for (let i = 0; i < 8; i++) {
        const res = stepGearSequential({ gear: cur, engineOn: true }, 0, 1, 1);
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
];
