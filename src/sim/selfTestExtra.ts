/**
 * @module sim/selfTestExtra
 * @layer pure-core
 * @role Расширенный набор автотестов ядра: USB-руль (T17), журнал и ДИ Уилсона (T19), реплей (T22, T24), выворот (T23), АКПП/аварийка (T25), Markdown (T26), OSM XML и редактор карт (T27–T29), каталог OSM-маршрутов и масштабируемый граф (T32–T33), автопарк Kia (T34).
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
import { cropOsmPackToPolygon, parseMapFileText, parseOsmXml } from "../maps/osmLoader";
import { isInsideWorldBoundary, isValidBoundaryPolygon } from "../maps/boundary";
import { findRoadNetworkPath, roadGeometryPoints } from "../maps/route";
import { buildExamRouteRecord, fingerprintOsmScenario, isExamRouteRecord, reviseExamRouteRecord } from "../maps/routeCatalog";
import { buildScenarioWorld } from "../scenarios/catalog";
import {
  buildCustomWorld,
  defaultCustomScenario,
  customFromOsmPack,
  customFromWorld,
  emptyCustomScenario,
  importEditorFileText,
  validateCustomScenario,
} from "../scenarios/custom";
import {
  appendRoadPoint,
  applyPresetBoundaryShape,
  clearBoundaryPolygon,
  setCustomBoundaryPolygon,
  attachCheckpointToSign,
  createEditorHistory,
  deleteSelected,
  duplicateSelected,
  fitBoundsToContent,
  moveSelected,
  placeObjectAt,
  pushEditorHistory,
  redoEditorHistory,
  rotateSelected,
  undoEditorHistory,
} from "../scenarios/editorOps";
import { OBSTACLE_CATALOG, ROAD_SIGN_CATALOG } from "../scenarios/signs";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET } from "../scoring/rules";
import { checkEngineToggle, checkGearChange, PARK_LOCK_MAX_SPEED_MS } from "./controls";
import { joinAttempt, splitAttempt, upsertJournal, upsertReview, type AttemptMeta } from "./journal";
import { AttemptRecorder, quantizeInput, replayInputStream, type RecordedAttempt } from "./recorder";
import { SpatialGrid } from "./spatialGrid";
import { createInitialState, createReadyInput, getActiveSpeedLimit, stepSimulation } from "./step";
import type { RoadSegment, SimEvent } from "./types";
import { ackermannAngle, CAR, carGeometry, centralSteerLimit, clamp, computeEngineAccel, computeRoadDragDecel, FIXED_DT, getCarCorners, normalizeWheelLock, outerTurningRadius, predictTrajectoryArc, STEER_WHEEL, wheelDegToSteerRad, writeTrajectoryArcPositions } from "./vehicle";
import { PLAYER_CARS, playerCarPhysics } from "./playerCar";

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
          input.throttleMultiplier = 1 + Math.min(1, t / 60); // плавный разгон Shift до x2
          if (quantize) quantizeInput(input);
          const out = stepSimulation(state, input, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          state = out.state;
          recorder.recordTick(input, state, out.newEvents);
        }
        const snap = recorder.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
        // Через JSON — как при сохранении в журнал и экспорте golden-набора
        const stream = JSON.parse(JSON.stringify(snap.inputStream)) as RecordedAttempt["inputStream"];
        const replay = replayInputStream(stream, world, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
        const boostMax = Math.max(...snap.inputStream.map((f) => f.input.throttleMultiplier ?? 1));
        return { state, replay, events: snap.events.length, frames: snap.inputStream.length, boostMax };
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
        assert(run.boostMax === 2, `Реплей ${label}: множитель Shift должен достигать x2`);
      }
      return "900 тиков, руль +5,67°/тик, синусоида газа и Shift x1→x2: Δx = Δz = Δh = 0, события совпали";
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
      // Буферный writer должен совпадать с объектным эталоном для прямого и обратного хода.
      const left = new Float32Array(19 * 3);
      const right = new Float32Array(19 * 3);
      const samples = [
        { x: 0, z: 0, h: 0, steer: 0, reverse: false },
        { x: 12.5, z: -4.25, h: 0.31, steer: 0.42, reverse: false },
        { x: -8, z: 17, h: -0.62, steer: -0.28, reverse: true },
      ];
      for (const sample of samples) {
        const expected = predictTrajectoryArc(sample.x, sample.z, sample.h, sample.steer, sample.reverse, 6.2, 18);
        writeTrajectoryArcPositions(sample.x, sample.z, sample.h, sample.steer, sample.reverse, left, right, 6.2, 18, 0.06);
        for (let i = 0; i <= 18; i++) {
          const offset = i * 3;
          assert(Math.abs(left[offset] - expected.leftTrack[i].x) < 1e-5, `Левая точка ${i}: X расходится`);
          assert(Math.abs(left[offset + 2] - expected.leftTrack[i].z) < 1e-5, `Левая точка ${i}: Z расходится`);
          assert(Math.abs(right[offset] - expected.rightTrack[i].x) < 1e-5, `Правая точка ${i}: X расходится`);
          assert(Math.abs(right[offset + 2] - expected.rightTrack[i].z) < 1e-5, `Правая точка ${i}: Z расходится`);
          assert(Math.abs(left[offset + 1] - 0.06) < 1e-7 && Math.abs(right[offset + 1] - 0.06) < 1e-7, `Точка ${i}: неверная высота линии`);
        }
      }
      let rejected = false;
      try {
        writeTrajectoryArcPositions(0, 0, 0, 0, false, new Float32Array(3), new Float32Array(3), 6.2, 18);
      } catch (error) {
        rejected = error instanceof RangeError;
      }
      assert(rejected, "Короткий буфер должен отклоняться с RangeError");
      return "240 тиков: 33° → 42° → 37,5° · 3 блока RLE · реплей точен · буферная дуга совпала с эталоном";
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

      // Стартовую прямоугольную асфальтовую площадку можно отключить, не удаляя дороги/объекты карты.
      const lotDef = defaultCustomScenario();
      const lotOnWorld = buildCustomWorld(lotDef);
      const lotOffWorld = buildCustomWorld({ ...lotDef, useLotSurface: false });
      assert(lotOnWorld.roads.some((road) => road.id === "custom-lot"), "Стартовая площадка должна быть в шаблоне по умолчанию");
      assert(!lotOffWorld.roads.some((road) => road.id === "custom-lot"), "При отключении площадка не должна попадать в 3D-мир");
      assert(lotOffWorld.bays.length === lotOnWorld.bays.length && lotOffWorld.obstacles.length === lotOnWorld.obstacles.length,
        "Отключение асфальта не должно удалять боксы и препятствия");

      const sharp = [{ x: 0, z: 0 }, { x: 0, z: 20 }, { x: 20, z: 20 }];
      const rounded = roadGeometryPoints(sharp, 5);
      assert(rounded.length > sharp.length, "Скругление должно добавлять промежуточные точки дуги");
      assert(rounded[0].x === 0 && rounded[0].z === 0 && rounded[rounded.length - 1].x === 20 && rounded[rounded.length - 1].z === 20,
        "Скругление должно сохранять начало и конец дороги");
      assert(roadGeometryPoints(sharp, 0).length === sharp.length, "Нулевой радиус должен сохранять острые углы");
      const curvedDef = { ...emptyCustomScenario(), roads: [{ id: "rounded", points: sharp, width: 1.5, lanes: 1, highway: "service", cornerRadiusM: 5 }] };
      const curvedWorld = buildCustomWorld(curvedDef);
      assert(curvedWorld.roads.find((road) => road.id === "rounded")?.points.length === sharp.length,
        "WorldData должен сохранять исходные контрольные точки без повторного сглаживания");
      assert(validateCustomScenario(curvedDef).errors.length === 0, "Ширина 1,5 м должна проходить валидацию");

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
        roads: [
          { id: "road-main", points: [{ x: 0, z: -20 }, { x: 0, z: 80 }], width: 8, lanes: 2, highway: "primary" },
          { id: "road-cross", points: [{ x: -20, z: 12 }, { x: 20, z: 12 }], width: 8, lanes: 2, highway: "secondary" },
        ],
        signs: [
          { id: "s-30", kind: "speed_limit", x: -3, z: 2, h: 0, limitKmh: 30, zoneRadius: 100, zoneX: 0, zoneZ: 2 },
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
      assert(getActiveSpeedLimit(0, 11, world) === 30, "Ограничение должно действовать до перекрёстка");
      assert(getActiveSpeedLimit(0, 14, world) === 60, "Перекрёсток должен отменять ограничение скорости");
      assert(getActiveSpeedLimit(0, 25, world) === 20, "Знак 5.21 должен задавать новый участок ограничения");
      assert(getActiveSpeedLimit(-20, -20, world) === 60, "Вне зон должен действовать базовый лимит 60 км/ч");
      assert(getActiveSpeedLimit(0, 35, world) === 60, "Ограничение 5.21 должно завершаться по заданной длине 8 м");

      // Любое геометрическое примыкание/пересечение дороги обрывает отрезок,
      // даже если угол очень острый и поперечная дорога заканчивается на оси основной.
      const shallowJunctionWorld = buildCustomWorld({
        ...def,
        roads: [
          { id: "road-main", points: [{ x: 0, z: -20 }, { x: 0, z: 80 }], width: 8, lanes: 2, highway: "primary" },
          { id: "road-shallow", points: [{ x: -20, z: 12 }, { x: 0.2, z: 12.875 }], width: 8, lanes: 1, highway: "service" },
        ],
      });
      assert(getActiveSpeedLimit(0, 10, shallowJunctionWorld) === 30, "До острого T-примыкания должен действовать лимит 30 км/ч");
      assert(getActiveSpeedLimit(0, 15, shallowJunctionWorld) === 60, "Острое T-примыкание должно сбрасывать ограничение");

      // Параллельная соседняя дорога сама по себе не является перекрёстком.
      const parallelRoadWorld = buildCustomWorld({
        ...def,
        roads: [
          { id: "road-main", points: [{ x: 0, z: -20 }, { x: 0, z: 80 }], width: 8, lanes: 2, highway: "primary" },
          { id: "road-parallel", points: [{ x: 2, z: -20 }, { x: 2, z: 80 }], width: 8, lanes: 1, highway: "service" },
        ],
      });
      assert(getActiveSpeedLimit(0, 15, parallelRoadWorld) === 30, "Параллельная дорога не должна сбрасывать ограничение");

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

      return "12 знаков · 8 препятствий · стартовая асфальтовая площадка отключается отдельно · отрезки 30/20 км/ч · перекрёсток отменяет лимит · КТ STOP · реплей бит-в-бит";
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
    suite: "scenarios",
    name: "Произвольная форма площадки и полигональные границы мира",
    fn: () => {
      const base = emptyCustomScenario();
      const points = [
        { x: -40, z: -30 }, { x: 40, z: -30 }, { x: 40, z: 30 }, { x: -40, z: 30 },
      ];
      const applied = setCustomBoundaryPolygon(base, points);
      assert(applied.ok && isValidBoundaryPolygon(applied.def.boundaryPolygon), "Валидный контур должен применяться");
      const world = buildCustomWorld(applied.def);
      assert(world.boundaryPolygon?.length === 4 && world.lotPolygon?.length === 4, "Полигон должен попасть в мир и геометрию асфальта");
      assert(isInsideWorldBoundary(0, 0, world.bounds, world.boundaryPolygon), "Центр должен находиться внутри границы");
      assert(!isInsideWorldBoundary(60, 0, world.bounds, world.boundaryPolygon), "Точка за контуром должна считаться внешней");
      const preset = applyPresetBoundaryShape(base, "l_shape");
      assert(preset.vertices >= 6 && isValidBoundaryPolygon(preset.def.boundaryPolygon), "Готовая Г-образная форма должна быть валидна");
      const cleared = clearBoundaryPolygon(applied.def);
      assert(!cleared.boundaryPolygon && cleared.bounds.minX < cleared.bounds.maxX, "Сброс контура должен вернуть прямоугольные границы");
      return "Ручной полигон · асфальт по форме · принадлежность области · Г-образный шаблон · сброс контура OK";
    },
  },
  {
    id: "T31",
    suite: "maps",
    name: "Расширенный OSM: oneway=-1, roundabout, service, полосы, multipolygon и обрезка",
    fn: () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <bounds minlat="55.7480" minlon="37.6080" maxlat="55.7540" maxlon="37.6160"/>
  <node id="1" lat="55.7500" lon="37.6100"/><node id="2" lat="55.7510" lon="37.6100"/>
  <node id="3" lat="55.7510" lon="37.6110"/><node id="4" lat="55.7500" lon="37.6110"/>
  <node id="5" lat="55.7505" lon="37.6105"/>
  <node id="6" lat="55.7507" lon="37.6105"/><node id="7" lat="55.7507" lon="37.6107"/>
  <node id="8" lat="55.7505" lon="37.6107"/>
  <node id="9" lat="55.7520" lon="37.6120"/><node id="10" lat="55.7525" lon="37.6120"/>
  <node id="11" lat="55.7525" lon="37.6125"/><node id="12" lat="55.7520" lon="37.6125"/>
  <node id="13" lat="55.7521" lon="37.6121"/><node id="14" lat="55.7524" lon="37.6121"/>
  <node id="15" lat="55.7524" lon="37.6124"/><node id="16" lat="55.7521" lon="37.6124"/>
  <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="secondary"/><tag k="name" v="Обратная улица"/><tag k="oneway" v="-1"/><tag k="lanes" v="3"/><tag k="width" v="9.5"/></way>
  <way id="101"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/><tag k="highway" v="residential"/><tag k="junction" v="roundabout"/></way>
  <way id="102"><nd ref="9"/><nd ref="10"/><tag k="highway" v="service"/><tag k="service" v="parking_aisle"/><tag k="lanes" v="1"/><tag k="width" v="4.2"/></way>
  <way id="200"><nd ref="9"/><nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="9"/></way>
  <way id="201"><nd ref="13"/><nd ref="14"/><nd ref="15"/><nd ref="16"/><nd ref="13"/></way>
  <relation id="300"><member type="way" ref="200" role="outer"/><member type="way" ref="201" role="inner"/><tag k="type" v="multipolygon"/><tag k="building" v="apartments"/></relation>
</osm>`;
      const pack = parseOsmXml(xml, "OSM advanced test");
      const reverse = pack.roads.find((r) => r.id === "way-100");
      const roundabout = pack.roads.find((r) => r.id === "way-101");
      const service = pack.roads.find((r) => r.id === "way-102");
      assert(Boolean(reverse?.oneway) && reverse!.points[0].z > reverse!.points[reverse!.points.length - 1].z,
        "oneway=-1 должен развернуть направление осевой линии");
      assert(reverse!.lanes === 3 && Math.abs(reverse!.width - 9.5) < 0.01, "Не применились lanes=3 и width=9.5");
      assert(Boolean(roundabout?.roundabout) && Boolean(roundabout?.oneway), "Кольцо должно распознаваться как roundabout/oneway");
      assert(service?.service === "parking_aisle" && service.lanes === 1 && Math.abs(service.width - 4.2) < 0.01,
        "Не распознаны service=parking_aisle, lanes и ширина");
      assert(pack.buildings.length >= 2, "Мультиполигон здания с внутренним двором должен разбиваться на корпуса");
      assert(Boolean(pack.meta.origin), `Не сохранён WGS84 origin: ${JSON.stringify(pack.meta)}`);
      assert(pack.bounds.maxX - pack.bounds.minX > 100,
        `Границы должны отражать реальный размер импортированной карты: ${JSON.stringify(pack.bounds)}`);
      const p = reverse!.points;
      const cropped = cropOsmPackToPolygon(pack, [
        { x: Math.min(...p.map((v) => v.x)) - 8, z: Math.min(...p.map((v) => v.z)) - 8 },
        { x: Math.max(...p.map((v) => v.x)) + 8, z: Math.min(...p.map((v) => v.z)) - 8 },
        { x: Math.max(...p.map((v) => v.x)) + 8, z: Math.max(...p.map((v) => v.z)) + 8 },
        { x: Math.min(...p.map((v) => v.x)) - 8, z: Math.max(...p.map((v) => v.z)) + 8 },
      ]);
      assert(Boolean(cropped.boundaryPolygon) && cropped.roads.length >= 1,
        "Обрезка OSM-пакета по полигону должна сохранять границу и дорогу");
      return `oneway=-1 · roundabout · service/lanes/width · courtyard=${pack.buildings.length} корп. · crop OK`;
    },
  },
  {
    id: "T32",
    suite: "maps",
    name: "Каталог OSM-маршрутов: связность, one-way, контрольные точки и снимок карты",
    fn: () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <bounds minlat="55.7480" minlon="37.6080" maxlat="55.7540" maxlon="37.6160"/>
  <node id="1" lat="55.7500" lon="37.6100"/>
  <node id="2" lat="55.7510" lon="37.6100"/>
  <node id="3" lat="55.7520" lon="37.6100"/>
  <node id="4" lat="55.7510" lon="37.6110"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="secondary"/><tag k="name" v="Улица Сетевая"/><tag k="oneway" v="yes"/></way>
  <way id="11"><nd ref="2"/><nd ref="4"/><tag k="highway" v="residential"/><tag k="name" v="Переулок Связной"/></way>
</osm>`;
      const source = customFromOsmPack(parseOsmXml(xml, "Тестовый квартал"));
      const mainRoad = source.roads![0];
      const sideRoad = source.roads![1];
      const result = buildExamRouteRecord(
        source,
        mainRoad.points[0],
        sideRoad.points[sideRoad.points.length - 1],
        "Маршрут через перекрёсток",
        "route-test-32",
        "2026-11-19T00:00:00.000Z",
        45
      );
      if (!result.ok) throw new Error(result.error);
      const record = result.record;
      assert(record.lengthM > 25 && record.path.length >= 3, "Маршрут должен пройти по обеим улицам и быть длиннее 25 м");
      assert(record.roadNames.includes("Улица Сетевая") && record.roadNames.includes("Переулок Связной"),
        `В пути потерялись улицы: ${record.roadNames.join(", ")}`);
      assert(record.roadNames[0] === "Улица Сетевая" && record.roadNames[1] === "Переулок Связной",
        "Названия улиц должны идти в порядке прохождения маршрута");
      const reverse = buildExamRouteRecord(
        source,
        sideRoad.points[sideRoad.points.length - 1],
        mainRoad.points[0],
        "Запрещённое направление",
        "route-test-32-reverse",
        "2026-11-19T00:00:00.000Z"
      );
      assert(!reverse.ok && reverse.error.includes("one-way"),
        "Путь против one-way должен быть отклонён с понятной причиной");
      const shortReverse = findRoadNetworkPath([{
        id: "oneway-short",
        points: [{ x: 0, z: 0 }, { x: 0, z: 100 }],
        width: 8, lanes: 2, highway: "secondary", oneway: true,
      }], { x: 0, z: 60 }, { x: 0, z: 58 }, 10);
      assert(!shortReverse.connected && Boolean(shortReverse.wrongWay),
        "Даже короткий путь против one-way на одном длинном сегменте должен блокироваться");
      assert(record.checkpoints.length >= 2 && record.checkpoints[record.checkpoints.length - 1]?.requireStop === true,
        "Нужны промежуточные КТ и финальная КТ с остановкой");
      assert(record.scenarioSnapshot.mapMeta?.attribution === "© OpenStreetMap contributors",
        "Снимок должен сохранять атрибуцию OSM");
      assert(Math.hypot(record.scenarioSnapshot.start.x - record.path[0].x, record.scenarioSnapshot.start.z - record.path[0].z) >= 0.7,
        "Стартовая поза должна быть смещена с оси в правую полосу");
      assert(record.scenarioSnapshot.start.x < record.path[0].x,
        "На прямом участке с курсом +Z старт должен находиться справа от осевой линии");
      assert((record.maneuvers?.length ?? 0) >= 1 && record.checkpoints.some((checkpoint) => Boolean(checkpoint.requireSignal)),
        "Поворот должен выделяться отдельной контрольной точкой с требованием указателя");
      assert(isExamRouteRecord(record), "Корректная запись должна проходить проверку формата");
      const editedCheckpoints = record.checkpoints.map((checkpoint, index) => index === 0
        ? { ...checkpoint, instruction: "Проверить перекрёсток и выполнить задание инструктора.", requireSignal: "left" as const }
        : checkpoint);
      const revised = reviseExamRouteRecord(record, "Маршрут после редактора", editedCheckpoints, "2026-11-19T01:00:00.000Z");
      assert(revised.ok, revised.ok ? "" : revised.error);
      if (revised.ok) {
        assert(revised.record.scenarioSnapshot.title === revised.record.title, "Название snapshot должно обновляться вместе с записью");
        assert(revised.record.scenarioSnapshot.checkpoints[0].instruction === editedCheckpoints[0].instruction,
          "Изменённые задания КТ должны попасть в исполняемый snapshot");
        assert(isExamRouteRecord(revised.record), "Отредактированный маршрут должен проходить проверку формата");
      }
      const withoutFinalStop = editedCheckpoints.map((checkpoint, index) =>
        index === editedCheckpoints.length - 1 ? { ...checkpoint, requireStop: false } : checkpoint);
      const invalidEdit = reviseExamRouteRecord(record, "Неверный финиш", withoutFinalStop, "2026-11-19T01:00:00.000Z");
      assert(!invalidEdit.ok, "Финиш маршрута должен сохранять обязательную остановку");
      const withEditorLot = { ...source, roads: [...source.roads!, { ...source.roads![0], id: "custom-lot" }] };
      const lotRoute = buildExamRouteRecord(
        withEditorLot, mainRoad.points[0], sideRoad.points[sideRoad.points.length - 1],
        "Маршрут с редакторской площадкой", "route-test-32-lot", "2026-11-19T00:00:00.000Z", 45
      );
      assert(lotRoute.ok && isExamRouteRecord(lotRoute.record),
        "Редакторская площадка не должна ломать fingerprint маршрута и snapshot");
      assert(!isExamRouteRecord({ ...record, path: [] }), "Повреждённый путь должен отклоняться");
      const changed = {
        ...source,
        roads: source.roads!.map((road, index) => index === 0
          ? { ...road, points: road.points.map((point, i) => i === 0 ? { x: point.x + 1, z: point.z } : point) }
          : road),
      };
      assert(fingerprintOsmScenario(source) !== fingerprintOsmScenario(changed),
        "Изменение геометрии карты должно менять fingerprint");
      return `${(record.lengthM / 1000).toFixed(2)} км · ${record.roadNames.length} улицы · ${record.checkpoints.length} КТ · снимок OSM и fingerprint OK`;
    },
  },
  {
    id: "T33",
    suite: "maps",
    name: "Маршрутизатор OSM: граф больше 1600 узлов и поиск A*",
    fn: () => {
      const main: RoadSegment = {
        id: "large-main",
        points: Array.from({ length: 1702 }, (_, i) => ({ x: 0, z: i * 4 })),
        width: 8,
        lanes: 2,
        highway: "secondary",
        name: "Длинная улица",
      };
      const connector: RoadSegment = {
        id: "large-connector",
        points: [{ x: 0, z: 6804 }, { x: 80, z: 6804 }],
        width: 8,
        lanes: 2,
        highway: "residential",
        name: "Поперечный проезд",
      };
      const result = findRoadNetworkPath([main, connector], { x: 0, z: 0 }, { x: 80, z: 6804 }, 10);
      assert(result.connected, "Граф больше 1600 узлов должен оставаться связным");
      assert(result.path.length > 1600, `Ожидался путь через более 1600 узлов, получено ${result.path.length}`);
      assert(result.roadNames.includes("Длинная улица") && result.roadNames.includes("Поперечный проезд"),
        "A* должен сохранить названия обеих улиц");
      assert(result.lengthM > 6800 && result.lengthM < 7000, `Неверная длина пути: ${result.lengthM}`);
      return `${result.path.length} узлов · ${Math.round(result.lengthM)} м · A* и пространственные индексы OK`;
    },
  },
  {
    id: "T34",
    suite: "vehicle",
    name: "Автопарк Kia: паспорта, габариты, геометрия и индивидуальная динамика",
    fn: () => {
      const expected = ["picanto", "rio", "ceed", "xceed", "sorento"];
      assert(PLAYER_CARS.map((car) => car.id).join(",") === expected.join(","), "В парке должны быть ровно пять моделей Kia");
      for (const car of PLAYER_CARS) {
        const geo = carGeometry(car.id);
        const corners = getCarCorners(0, 0, 0, geo);
        const front = { x: (corners[0].x + corners[1].x) / 2, z: (corners[0].z + corners[1].z) / 2 };
        const rear = { x: (corners[2].x + corners[3].x) / 2, z: (corners[2].z + corners[3].z) / 2 };
        const length = Math.hypot(front.x - rear.x, front.z - rear.z);
        const width = Math.hypot(corners[0].x - corners[1].x, corners[0].z - corners[1].z);
        assert(Math.abs(length - car.length) < 1e-6, `${car.name}: длина кузова не совпадает с паспортом`);
        assert(Math.abs(width - car.width) < 1e-6, `${car.name}: ширина кузова не совпадает с паспортом`);
        const physics = playerCarPhysics(car.id);
        assert(physics.vmaxKmh === car.vmaxKmh && physics.wheelbase === car.wheelbase, `${car.name}: физика не связана с паспортом`);
        assert(computeEngineAccel(1, "D", 1, 0, true, false, 0, physics.accelScale, physics.vmaxKmh) > 0,
          `${car.name}: двигатель не развивает тягу`);
      }
      assert(playerCarPhysics("picanto").vmaxKmh < playerCarPhysics("sorento").vmaxKmh,
        "Ограничитель скорости должен различаться между моделями");
      assert(computeEngineAccel(1, "D", 1, 0, true, false) > computeEngineAccel(1, "D", 6, 0, true, false),
        "Первая передача должна иметь большую тягу, чем шестая");
      assert(computeRoadDragDecel(10, 0, 1, "D", true, 1) > computeRoadDragDecel(10, 0, 0, "N", true, 1),
        "Включённая передача должна создавать engine braking сильнее нейтрали");
      return "5 моделей · габариты, 6 ступеней и engine braking соответствуют модели";
    },
  },
];
