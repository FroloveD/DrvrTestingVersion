/**
 * @module sim/selfTestExtra
 * @layer pure-core
 * @role Расширенный набор автотестов ядра: USB-руль (T17), журнал и ДИ Уилсона (T19), реплей (T22, T24), выворот (T23), АКПП/аварийка (T25), Markdown-отчёт (T26).
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
import { buildScenarioWorld } from "../scenarios/catalog";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET } from "../scoring/rules";
import { checkEngineToggle, checkGearChange, PARK_LOCK_MAX_SPEED_MS } from "./controls";
import { joinAttempt, splitAttempt, upsertJournal, upsertReview, type AttemptMeta } from "./journal";
import { AttemptRecorder, quantizeInput, replayInputStream, type RecordedAttempt } from "./recorder";
import { SpatialGrid } from "./spatialGrid";
import { createInitialState, createReadyInput, stepSimulation } from "./step";
import type { SimEvent } from "./types";
import { ackermannAngle, CAR, centralSteerLimit, clamp, FIXED_DT, normalizeWheelLock, outerTurningRadius, STEER_WHEEL, wheelDegToSteerRad } from "./vehicle";

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
];
