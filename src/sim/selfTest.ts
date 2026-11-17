import {
  DEFAULT_GAMEPAD_CONFIG,
  detectWheelProfile,
  mapGamepadSnapshot,
  type RawGamepadSnapshot,
} from "../input/gamepad";
import { parseOsmOrGeoJson } from "../maps/osmLoader";
import { buildScenarioWorld } from "../scenarios/catalog";
import { buildCustomWorld, defaultCustomScenario, validateCustomScenario } from "../scenarios/custom";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET, evaluateAttempt } from "../scoring/rules";
import { buildGoldenSet } from "./golden";
import { AttemptRecorder, replayInputStream, type RecordedAttempt } from "./recorder";
import { trafficPoseAt } from "./traffic";
import type { TrafficVehicleDef } from "./types";
import {
  attemptsToCsv,
  buildAttemptReport,
  EMPTY_STUDENT_META,
  reportToMarkdown,
  violationsToCsv,
} from "../stats/report";
import { checkCarCollisionBruteForce, isCarInsideBay, SpatialGrid } from "./spatialGrid";
import { createInitialInput, createInitialState, createReadyInput, stepSimulation } from "./step";
import type { SimEvent } from "./types";
import { ackermannAngle, CAR, FIXED_DT, getCarCorners, getTurnSignalFlash } from "./vehicle";

export type TestCaseResult = {
  id: string;
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  detail: string;
};

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

export function runAllSelfTests(): TestCaseResult[] {
  const cases: Array<{ id: string; suite: string; name: string; fn: () => string }> = [
    {
      id: "T01",
      suite: "vehicle",
      name: "Инвариант №1: координаты (+Z вперёд, +X лево, +h поворот влево)",
      fn: () => {
        const world = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const openWorld = { ...world, obstacles: [], start: { x: 0, z: 0, h: 0 } };
        const grid = new SpatialGrid([], 10);
        let s = createInitialState(openWorld, true);
        const inp = { ...createReadyInput("D"), throttle: 0.85, steerWheelDeg: 270 };
        for (let i = 0; i < 90; i++) {
          s = stepSimulation(s, inp, openWorld, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
        }
        assert(s.z > 1.2, `Ожидалось z > 1.2, получено ${s.z.toFixed(3)}`);
        assert(s.x > 0.12, `При повороте влево (+swDeg) ожидалось смещение в +X, получено ${s.x.toFixed(3)}`);
        assert(s.h > 0.12, `Ожидалось h > 0, получено ${s.h.toFixed(3)}`);
        return `Через 1.5 с: x=+${s.x.toFixed(2)} м (+X лево), z=+${s.z.toFixed(2)} м (+Z вперёд), h=+${((s.h * 180) / Math.PI).toFixed(1)}°`;
      },
    },
    {
      id: "T02",
      suite: "vehicle",
      name: "Геометрия Аккермана Kia Ceed: внутреннее колесо 35°, внешнее ≈ 26.2°",
      fn: () => {
        const leftDeg = (ackermannAngle(1, CAR.maxSteer) * 180) / Math.PI;
        const rightDeg = (ackermannAngle(-1, CAR.maxSteer) * 180) / Math.PI;
        assert(Math.abs(leftDeg - 35) < 0.08, `Внутреннее колесо ${leftDeg.toFixed(2)}° != 35°`);
        assert(rightDeg > 25.5 && rightDeg < 26.8, `Внешнее колесо ${rightDeg.toFixed(2)}° вне диапазона`);
        assert(leftDeg > rightDeg, "Внутреннее колесо должно поворачиваться сильнее внешнего");
        const rLeft = (ackermannAngle(1, -CAR.maxSteer) * 180) / Math.PI;
        const rRight = (ackermannAngle(-1, -CAR.maxSteer) * 180) / Math.PI;
        assert(Math.abs(rRight + 35) < 0.08 && Math.abs(rLeft + rightDeg) < 0.05, "Нарушена симметрия право/лево");
        return `Внутреннее: ${leftDeg.toFixed(2)}°, центральный: ${((CAR.maxSteer * 180) / Math.PI).toFixed(2)}°, внешнее: ${rightDeg.toFixed(2)}°`;
      },
    },
    {
      id: "T03",
      suite: "vehicle",
      name: "Инвариант №11: тормоз S в режиме D гасит скорость до 0 и не даёт реверс",
      fn: () => {
        const world = { ...buildScenarioWorld("bay_90", DEFAULT_CALIBRATION), obstacles: [], start: { x: 0, z: 0, h: 0 } };
        const grid = new SpatialGrid([], 10);
        let s = createInitialState(world, true);
        // Разгоняемся в D
        for (let i = 0; i < 60; i++) {
          s = stepSimulation(s, { ...createReadyInput("D"), throttle: 1 }, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
        }
        const peakV = s.v;
        // Зажимаем тормоз S на 3 секунды
        for (let i = 0; i < 180; i++) {
          s = stepSimulation(s, { ...createReadyInput("D"), brake: 1 }, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
          assert(s.v >= 0, `Отрицательная скорость в D при торможении: ${s.v}`);
        }
        assert(s.v === 0, `Скорость должна стать ровно 0, получено ${s.v}`);
        return `Разгон до ${(peakV * 3.6).toFixed(1)} км/ч → полное торможение до ${s.v.toFixed(2)} м/с без отката`;
      },
    },
    {
      id: "T04",
      suite: "core",
      name: "Детерминизм фиксированного шага: 30 FPS vs 144 FPS дают идентичную позу",
      fn: () => {
        const world = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        const runWithFps = (fps: number) => {
          let s = createInitialState(world, true);
          let acc = 0;
          const totalDuration = 3.0;
          const frameDt = 1 / fps;
          let elapsed = 0;
          while (elapsed < totalDuration - 1e-9) {
            acc += Math.min(frameDt, 0.1);
            elapsed += frameDt;
            while (acc >= FIXED_DT - 1e-12) {
              const inp = {
                ...createReadyInput("R"),
                throttle: s.tick < 110 ? 0.55 : 0,
                brake: s.tick >= 110 ? 0.6 : 0,
                steerWheelDeg: s.tick < 85 ? -360 : 0,
              };
              s = stepSimulation(s, inp, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT).state;
              acc -= FIXED_DT;
            }
          }
          return s;
        };
        const s30 = runWithFps(30);
        const s144 = runWithFps(144);
        // Сравниваем по одинаковому числу тиков (179 тиков)
        assert(Math.abs(s30.tick - s144.tick) <= 1, `Разница тиков > 1: ${s30.tick} vs ${s144.tick}`);
        let aligned = s30;
        if (s144.tick > s30.tick) {
          aligned = stepSimulation(
            s30,
            { ...createReadyInput("R"), brake: 0.6 },
            world,
            grid,
            DEFAULT_CALIBRATION,
            DEFAULT_RULESET,
            FIXED_DT
          ).state;
        }
        assert(aligned.x === s144.x && aligned.z === s144.z && aligned.h === s144.h, "Позы разошлись!");
        return `Тик #${s144.tick}: Δx = 0.0000 м, Δz = 0.0000 м, Δh = 0.0000 рад`;
      },
    },
    {
      id: "T05",
      suite: "world",
      name: "Бордюры и занятые боксы не пересекаются со свободными боксами №2, 4, 5, 7",
      fn: () => {
        const world = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        const freeBays = world.bays.filter((b) => !b.occupied);
        assert(freeBays.length === 4, `Ожидалось 4 свободных бокса, найдено ${freeBays.length}`);
        for (const bay of freeBays) {
          assert(isCarInsideBay(bay.cx, bay.cz, bay.h, bay), `Kia Ceed не помещается в ${bay.label}`);
          const { hit } = grid.queryCarHit(bay.cx, bay.cz, bay.h);
          assert(!hit, `Ложный контакт в центре ${bay.label}: ${hit?.id}`);
        }
        return `Проверены боксы ${freeBays.map((b) => `№${b.id}`).join(", ")}: все 4 угла внутри, 0 ложных касаний`;
      },
    },
    {
      id: "T06",
      suite: "world",
      name: "Порт параллельной парковки v2: карманы №9 и №11 вмещают Kia Ceed без касаний",
      fn: () => {
        const world = buildScenarioWorld("parallel_v2", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        const bay9 = world.bays.find((b) => b.id === 9)!;
        const bay11 = world.bays.find((b) => b.id === 11)!;
        const bay10 = world.bays.find((b) => b.id === 10)!;
        assert(bay10.occupied && !bay9.occupied && !bay11.occupied, "Нарушена схема занятости №9–12");
        assert(isCarInsideBay(bay11.cx, bay11.cz, 0, bay11), "Машина не засчитана в кармане №11");
        assert(!grid.queryCarHit(bay11.cx, bay11.cz, 0).hit, "Ложное касание с бордюром в кармане №11");
        assert(!grid.queryCarHit(world.start.x, world.start.z, world.start.h).hit, "Контакт на старте");
        return `Карманы №9, №11 (${bay11.length}×${bay11.width} м) свободны; габариты ${CAR.length.toFixed(2)}×${CAR.width.toFixed(2)} м в норме`;
      },
    },
    {
      id: "T07",
      suite: "spatial",
      name: "SpatialGrid (10 м) совпадает с полным перебором на 150 тестовых позах",
      fn: () => {
        const world = buildScenarioWorld("city_osm", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        let seed = 42;
        const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
        let hits = 0;
        let maxChecked = 0;
        for (let i = 0; i < 150; i++) {
          const x = -70 + rand() * 130;
          const z = -60 + rand() * 145;
          const h = rand() * Math.PI * 2;
          const g = grid.queryCarHit(x, z, h);
          const bf = checkCarCollisionBruteForce(x, z, h, world.obstacles);
          assert(Boolean(g.hit) === Boolean(bf), `Расхождение в точке (${x.toFixed(1)}, ${z.toFixed(1)})`);
          if (g.hit) hits++;
          if (g.checked > maxChecked) maxChecked = g.checked;
        }
        return `150/150 совпадений (пересечений: ${hits}), макс. проверок в ячейке: ${maxChecked} из ${world.obstacles.length}`;
      },
    },
    {
      id: "T08",
      suite: "scoring",
      name: "Правила оценки: пересечение линии = НЕ СДАЛ (5 б.), версия правил сохранена",
      fn: () => {
        const ev: SimEvent = {
          id: "ev-1",
          code: "line_cross",
          tick: 240,
          time: 4.0,
          x: 1.2,
          z: -2.1,
          h: 0.2,
          speedKmh: 4.2,
          detail: "Наезд на боковую линию бокса №2",
        };
        const res = evaluateAttempt([ev], 0, DEFAULT_RULESET);
        assert(res.verdict === "НЕ СДАЛ", `Ожидалось НЕ СДАЛ, получено ${res.verdict}`);
        assert(res.hasImmediateFail && res.totalPoints === 5, "Должен быть немедленный провал 5 баллов");
        assert(res.rulesVersion === DEFAULT_RULESET.version, "Потеряна версия правил");
        assert(res.legacyV8Score === 100, "В v8 без касания препятствия балл оставался 100");
        return `rules.json → ${res.verdict} (${res.totalPoints} б., ${res.rulesVersion}) vs v8 → ${res.legacyV8Score}/100`;
      },
    },
    {
      id: "T09",
      suite: "scoring",
      name: "Накопление мелких/средних ошибок: 4 балла = СДАЛ, 5 баллов = НЕ СДАЛ",
      fn: () => {
        const mk = (code: SimEvent["code"], tick: number): SimEvent => ({
          id: `${code}-${tick}`,
          code,
          tick,
          time: tick / 60,
          x: 0,
          z: 0,
          h: 0,
          speedKmh: 5,
          detail: code,
        });
        const pass4 = evaluateAttempt([mk("belt_unfastened", 60)], 0, DEFAULT_RULESET);
        const fail5 = evaluateAttempt([mk("belt_unfastened", 60), mk("no_turn_signal", 120)], 0, DEFAULT_RULESET);
        assert(pass4.verdict === "СДАЛ" && pass4.totalPoints === 4, "4 балла должны давать СДАЛ");
        assert(fail5.verdict === "НЕ СДАЛ" && fail5.totalPoints === 5, "4 + 1 = 5 баллов должны давать НЕ СДАЛ");
        return `4 б. → ${pass4.verdict}; 4 + 1 = 5 б. → ${fail5.verdict} (порог ${DEFAULT_RULESET.failThreshold})`;
      },
    },
    {
      id: "T10",
      suite: "replay",
      name: "RLE-рекордер и реплей воспроизводят заезд и нарушения бит-в-бит",
      fn: () => {
        const world = buildScenarioWorld("city_osm", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        let state = createInitialState(world, true);
        const rec = new AttemptRecorder(state, true);
        for (let t = 0; t < 150; t++) {
          // Намеренно едем с непристёгнутым ремнём и без поворотника
          const input = {
            ...createReadyInput("D"),
            belt: false,
            throttle: t < 110 ? 0.7 : 0,
            steerWheelDeg: t > 50 && t < 90 ? -45 : 0,
          };
          const out = stepSimulation(state, input, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          state = out.state;
          rec.recordTick(input, state, out.newEvents);
        }
        const snap = rec.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
        const replayed = replayInputStream(snap.inputStream, world, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
        assert(
          replayed.finalState.x === state.x &&
            replayed.finalState.z === state.z &&
            replayed.finalState.h === state.h,
          "Поза реплея не совпала с оригиналом"
        );
        assert(replayed.events.length === snap.events.length && snap.events.length >= 2, "События не совпали");
        return `150 тиков сжаты в ${snap.inputStream.length} RLE-фрейма; совпадение 100%, нарушений: ${replayed.events.length}`;
      },
    },
    {
      id: "T11",
      suite: "osm",
      name: "Парсер Overpass OSM JSON: дороги, здания (building:levels), светофоры и ODbL",
      fn: () => {
        const sample = {
          elements: [
            { type: "node", id: 1, lat: 55.75, lon: 37.61 },
            { type: "node", id: 2, lat: 55.751, lon: 37.61, tags: { highway: "traffic_signals" } },
            { type: "way", id: 10, nodes: [1, 2], tags: { highway: "secondary", name: "ул. Тестовая", maxspeed: "40" } },
            {
              type: "way",
              id: 20,
              geometry: [
                { lat: 55.7502, lon: 37.6104 },
                { lat: 55.7505, lon: 37.6104 },
                { lat: 55.7505, lon: 37.6108 },
                { lat: 55.7502, lon: 37.6108 },
              ],
              tags: { building: "apartments", "building:levels": "5" },
            },
          ],
        };
        const pack = parseOsmOrGeoJson(sample, "Тест Overpass");
        assert(pack.roads.length === 1 && pack.buildings.length === 1 && pack.signals.length === 1, "Неверное число объектов");
        assert(Math.abs(pack.buildings[0].height - 16) < 0.01, "5 этажей × 3.2 м должны дать 16 м");
        assert(pack.meta.attribution.includes("OpenStreetMap"), "Нет атрибуции ODbL");
        return `Дорог: ${pack.roads.length}, зданий: ${pack.buildings.length} (16.0 м), светофоров: ${pack.signals.length}, ${pack.meta.attribution}`;
      },
    },
    {
      id: "T12",
      suite: "osm",
      name: "Парсер GeoJSON FeatureCollection + габариты кузова getCarCorners",
      fn: () => {
        const gj = {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { highway: "residential", name: "пер. Школьный" },
              geometry: { type: "LineString", coordinates: [[37.61, 55.75], [37.611, 55.7508]] },
            },
            {
              type: "Feature",
              properties: { building: "yes", height: "12" },
              geometry: {
                type: "Polygon",
                coordinates: [[[37.6102, 55.7501], [37.6105, 55.7501], [37.6105, 55.7503], [37.6102, 55.7503], [37.6102, 55.7501]]],
              },
            },
          ],
        };
        const pack = parseOsmOrGeoJson(gj, "Тест GeoJSON");
        assert(pack.roads.length === 1 && pack.buildings.length === 1, "GeoJSON не распознан");
        const c = getCarCorners(0, 0, 0);
        const len = Math.hypot(c[0].x - c[3].x, c[0].z - c[3].z);
        const wid = Math.hypot(c[0].x - c[1].x, c[0].z - c[1].z);
        assert(Math.abs(len - CAR.length) < 1e-6 && Math.abs(wid - CAR.width) < 1e-6, "Искажены габариты кузова");
        return `GeoJSON OK (дорог ${pack.roads.length}, зданий ${pack.buildings.length}); кузов ${len.toFixed(2)}×${wid.toFixed(2)} м`;
      },
    },
    {
      id: "T13",
      suite: "input/render",
      name: "Поворотники Q/E и аварийка: общий таймер виден в 3D и на панели",
      fn: () => {
        const leftOn = getTurnSignalFlash("left", 0);
        const leftOff = getTurnSignalFlash("left", 0.36);
        const rightOn = getTurnSignalFlash("right", 0);
        const hazardOn = getTurnSignalFlash("hazard", 0);
        const hazardOff = getTurnSignalFlash("hazard", 0.36);
        assert(leftOn.leftLit && !leftOn.rightLit, "Левый сигнал должен включать только лампы +X");
        assert(!leftOff.leftLit && !leftOff.rightLit, "Левый сигнал должен мигать с полупериодом 350 мс");
        assert(rightOn.rightLit && !rightOn.leftLit, "Правый сигнал должен включать только лампы -X");
        assert(hazardOn.leftLit && hazardOn.rightLit, "Аварийка должна включать обе стороны");
        assert(!hazardOff.leftLit && !hazardOff.rightLit, "Аварийка должна мигать синхронно");
        return "Q → +X слева, E → -X справа, Z → обе стороны; on/off синхронизирован в 700 мс";
      },
    },
    {
      id: "T14",
      suite: "golden",
      name: "Golden-набор: стабильные checksum, версия правил и паспорт автомобиля",
      fn: () => {
        const world = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        let state = createInitialState(world, true);
        const rec = new AttemptRecorder(state, true);
        for (let t = 0; t < 90; t++) {
          const input = {
            ...createReadyInput("R"),
            throttle: t < 60 ? 0.45 : 0,
            brake: t >= 60 ? 0.7 : 0,
            steerWheelDeg: t < 45 ? -180 : 0,
          };
          const out = stepSimulation(state, input, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          state = out.state;
          rec.recordTick(input, state, out.newEvents);
        }
        const a = rec.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
        const vehicle = {
          model: CAR.model,
          length: CAR.length,
          width: CAR.width,
          wheelbase: CAR.wheelbase,
          maxSteerDeg: (CAR.maxSteer * 180) / Math.PI,
        };
        const set1 = buildGoldenSet([a], DEFAULT_RULESET, vehicle);
        const set2 = buildGoldenSet([a], DEFAULT_RULESET, vehicle);
        assert(set1.schema === "cdt.golden.v1", "Неверная схема golden-набора");
        assert(set1.attempts.length === 1 && set1.attempts[0].inputTicks > 0, "Пустой golden-заезд");
        assert(set1.attempts[0].checksum === set2.attempts[0].checksum, "Checksum нестабилен между вызовами");
        assert(/^[0-9a-f]{8}$/.test(set1.attempts[0].checksum), "Неверный формат checksum");
        assert(set1.ruleset.version === DEFAULT_RULESET.version, "Потеряна версия правил в golden-наборе");
        assert(Math.abs(set1.vehicle.lengthM - CAR.length) < 1e-9, "Потерян паспорт автомобиля");
        return `schema cdt.golden.v1 · ${set1.attempts[0].inputTicks} тиков · checksum ${set1.attempts[0].checksum} · rules ${set1.ruleset.version}`;
      },
    },
    {
      id: "T15",
      suite: "input",
      name: "Холодный старт: ДВС заглушен, КПП P, газ не двигает автомобиль",
      fn: () => {
        const base = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const world = { ...base, obstacles: [], start: { x: 0, z: 0, h: 0 } };
        const grid = new SpatialGrid([], 10);
        const cold = createInitialInput();
        let s = createInitialState(world, false);

        assert(s.gear === "P" && !s.engineOn && s.handbrake && !s.belt, "Нарушен холодный старт");
        assert(cold.gear === "P" && !cold.engineOn, "createInitialInput должен возвращать P и заглушенный ДВС");

        // ДВС заглушен, газ нажат — автомобиль стоит
        for (let i = 0; i < 120; i++) {
          s = stepSimulation(s, { ...cold, throttle: 1 }, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
        }
        assert(s.x === 0 && s.z === 0 && s.v === 0, "Заглушенный ДВС не должен двигать автомобиль");

        // ДВС запущен, ручник снят, газ нажат, но селектор остался в P — парковочная блокировка
        const running = { ...cold, engineOn: true, handbrake: false, belt: true, throttle: 1 };
        for (let i = 0; i < 120; i++) {
          s = stepSimulation(s, running, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
        }
        assert(s.x === 0 && s.z === 0 && s.v === 0, "P (Parking) должен блокировать движение даже с газом");

        // После выбора R автомобиль едет назад (в -Z)
        const reverse = { ...running, gear: "R" as const };
        for (let i = 0; i < 90; i++) {
          s = stepSimulation(s, reverse, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET).state;
        }
        assert(s.z < -0.2, `После выхода из P в R ожидался задний ход, z = ${s.z.toFixed(3)}`);
        return `Старт: P / ДВС off / ручник; P удерживает 240 тиков; после R пройдено ${Math.abs(s.z).toFixed(2)} м назад`;
      },
    },
    {
      id: "T16",
      suite: "scenarios",
      name: "Свой сценарий: шаблон валиден, мир собирается, геометрия проверяется",
      fn: () => {
        const def = defaultCustomScenario();
        const v = validateCustomScenario(def);
        assert(v.errors.length === 0, `Ошибки шаблона: ${v.errors.join("; ")}`);
        const world = buildCustomWorld(def);
        assert(world.scenarioId === "custom", "scenarioId должен быть custom");
        assert(world.roads.length === 1 && world.bays.length === 2, "Потеряны дорога или боксы");
        const parked = world.obstacles.filter((o) => o.kind === "parked_car");
        assert(parked.length === 1, `Ожидалось 1 авто в занятом боксе, найдено ${parked.length}`);

        // Свободный бокс вмещает Ceed без ложного контакта, на старте контакта нет
        const free = world.bays.find((b) => !b.occupied)!;
        assert(isCarInsideBay(free.cx, free.cz, free.h, free), "Ceed не помещается в свободный бокс шаблона");
        const grid = new SpatialGrid(world.obstacles, 10);
        assert(!grid.queryCarHit(world.start.x, world.start.z, world.start.h).hit, "Контакт на старте шаблона");

        // Невалидный сценарий ловится: пустое название + крошечный бокс + старт вне границ
        const bad = {
          ...def,
          title: "  ",
          start: { x: 999, z: 999, h: 0 },
          bays: [{ ...def.bays[0], width: 1.5, length: 3.0 }],
        };
        const badV = validateCustomScenario(bad);
        assert(badV.errors.length >= 3, `Ожидалось ≥3 ошибок, получено ${badV.errors.length}`);
        return `Шаблон: ${world.bays.length} бокса, ${world.obstacles.length} препятствий, warnings ${v.warnings.length}; брак ловится (${badV.errors.length} ошибок)`;
      },
    },
    {
      id: "T17",
      suite: "stats",
      name: "Отчёт автошколы: агрегация нарушений, доля сдачи, Markdown и CSV",
      fn: () => {
        const world = buildScenarioWorld("parallel_v2", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        let s = createInitialState(world, true);
        const rec = new AttemptRecorder(s, true);
        for (let t = 0; t < 120; t++) {
          const inp = { ...createReadyInput("R"), throttle: t < 80 ? 0.4 : 0, brake: t >= 80 ? 0.8 : 0 };
          const out = stepSimulation(s, inp, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          s = out.state;
          rec.recordTick(inp, s, out.newEvents);
        }
        const clean = rec.snapshot(s, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);

        // Вторая попытка: то же событие ремня → ровно одно нарушение с 4 баллами
        const beltEvent = {
          id: "belt-test-1",
          code: "belt_unfastened" as const,
          tick: 60,
          time: 1,
          x: 0,
          z: 0,
          h: 0,
          speedKmh: 3,
          detail: "Движение с непристёгнутым ремнём",
        };
        const withViolation: RecordedAttempt = {
          ...clean,
          id: "att-violation",
          scenarioId: "bay_90",
          scenarioTitle: "Бокс 90° задним ходом",
          durationSec: 14,
          events: [...clean.events, beltEvent],
          evaluation: evaluateAttempt([beltEvent], 0, DEFAULT_RULESET),
        };

        const report = buildAttemptReport([withViolation, clean], DEFAULT_RULESET, EMPTY_STUDENT_META);
        assert(report.attempts === 2 && report.pass === 2 && report.fail === 0, "Неверный счёт попыток");
        assert(report.passRatePct === 100, `Ожидалась сдача 100%, получено ${report.passRatePct}`);
        assert(report.byScenario.length === 2, `Ожидалось 2 упражнения, получено ${report.byScenario.length}`);
        const belt = report.violations.find((v) => v.code === "belt_unfastened");
        assert(Boolean(belt) && belt?.count === 1 && belt?.points === 4 && belt?.sharePct === 100, "Неверная агрегация нарушения");
        assert(report.recommendations.length >= 1, "Должна быть хотя бы одна рекомендация");
        assert(report.recommendations.some((r) => r.includes("Ремень")), "Нет рекомендации по ремню");

        const md = reportToMarkdown(report);
        assert(md.includes("# Отчёт по попыткам CityDrivingTraining"), "Нет заголовка отчёта");
        assert(md.includes("## Нарушения") && md.includes("Ремень"), "Markdown потерял раздел нарушений");
        assert(md.includes("Учебная симуляция"), "Markdown потерял дисклеймер");

        const csv = attemptsToCsv([withViolation, clean], DEFAULT_RULESET);
        assert(csv.trim().split("\n").length === 3, `Ожидалось 2 строки данных CSV, получено ${csv.split("\n").length - 1}`);
        assert(violationsToCsv(report).split("\n").length === 2, "CSV нарушений неверен");
        return `2 попытки · сдача ${report.passRatePct}% · 1 нарушение (4 б., 100%) · рекомендаций ${report.recommendations.length}`;
      },
    },
    {
      id: "T18",
      suite: "traffic",
      name: "Движущийся трафик: детерминизм позы/скорости, встречное столкновение",
      fn: () => {
        const def: TrafficVehicleDef = {
          id: "t18",
          points: [
            { x: 0, z: 0 },
            { x: 0, z: 100 },
          ],
          speed: 10,
          dir: 1,
          offset: 20,
          model: "rio",
        };
        const p0 = trafficPoseAt(def, 0);
        const p1 = trafficPoseAt(def, 1);
        assert(Math.abs(p0.z - 20) < 1e-6 && p0.h === 0, `Стартовая поза z=20 на север, получено z=${p0.z}`);
        assert(Math.abs(p1.z - 30) < 1e-6, `Скорость 10 м/с: через 1 с z=30, получено ${p1.z.toFixed(3)}`);
        const pWrap = trafficPoseAt(def, 9);
        assert(Math.abs(pWrap.z - 10) < 1e-6, `Цикл по участку: при t=9 z=10, получено ${pWrap.z.toFixed(3)}`);

        const world = buildScenarioWorld("city_osm", DEFAULT_CALIBRATION);
        assert(world.traffic.length === 4, `В городском мире 4 движущиеся машины, получено ${world.traffic.length}`);
        const grid = new SpatialGrid(world.obstacles, 10);

        // Издалека: ложных столкновений за первые 100 тиков нет
        let far = createInitialState(world, true);
        let evFar = 0;
        for (let i = 0; i < 100; i++) {
          const out = stepSimulation(far, createReadyInput("D"), world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          far = out.state;
          evFar += out.newEvents.filter((e) => e.code === "collision" && e.detail.includes("движущееся")).length;
        }
        assert(evFar === 0, "Ложное столкновение с трафиком");

        // Встречный удар: игрок едет на север прямо по встречной полосе (x = +2.2)
        let head = createInitialState(world, true);
        head.x = 2.2;
        head.z = 28;
        head.h = 0;
        let evHead = 0;
        let vAtHit: number | null = null;
        for (let i = 0; i < 150; i++) {
          const out = stepSimulation(
            head,
            { ...createReadyInput("D"), throttle: 0.6 },
            world,
            grid,
            DEFAULT_CALIBRATION,
            DEFAULT_RULESET,
            FIXED_DT
          );
          head = out.state;
          const hits = out.newEvents.filter((e) => e.code === "collision" && e.detail.includes("движущееся")).length;
          if (hits > 0 && vAtHit === null) vAtHit = out.state.v;
          evHead += hits;
        }
        assert(evHead >= 1, "Встречное столкновение с движущейся машиной не зафиксировано");
        assert(vAtHit === 0, `В тик удара скорость должна быть 0, получено ${String(vAtHit)}`);
        return `Поза детерминирована (10 м/с, цикл по участку) · 4 машины в городе · встречный удар: ${evHead} событий, v=${vAtHit} в тик удара`;
      },
    },
    {
      id: "T19",
      suite: "input",
      name: "Адаптер USB-руля и геймпада: профиль G29, мёртвая зона, педали и фронты кнопок",
      fn: () => {
        assert(detectWheelProfile("Logitech G29 Driving Force Racing Wheel") === "wheel_g29", "G29 не распознан");
        assert(detectWheelProfile("Xbox Wireless Controller") === "standard", "Xbox-пад должен быть standard");

        const mkButtons = (pressedIdx: number[]) =>
          Array.from({ length: 16 }, (_, i) => ({
            pressed: pressedIdx.includes(i),
            value: pressedIdx.includes(i) ? 1 : 0,
          }));

        // Шум в пределах мёртвой зоны (0.05 < 0.07) и отпущенные инвертированные педали (+1, +1)
        const idleSnap: RawGamepadSnapshot = {
          id: "Logitech G29 Driving Force",
          axes: [0.05, 0, 1.0, 0, 0, 1.0],
          buttons: mkButtons([]),
        };
        const cfg = { ...DEFAULT_GAMEPAD_CONFIG, profile: "wheel_g29" as const, deadzone: 0.07, invertPedals: true };
        const m0 = mapGamepadSnapshot(idleSnap, cfg, []);
        assert(!m0.steeringActive && m0.steerWheelDeg === 0, "Мёртвая зона не отсекла шум оси руля");
        assert(m0.throttle === 0 && m0.brake === 0, "Отпущенные инвертированные педали (+1) должны давать 0");

        // Полный поворот вправо (axis0 = +1 => swDeg = -540°), газ выжат (axis2 = -1 => 1), нажаты лепесток L (4) и R-передача (1)
        const activeSnap: RawGamepadSnapshot = {
          id: "Logitech G29 Driving Force",
          axes: [1.0, 0, -1.0, 0, 0, 0.2],
          buttons: mkButtons([1, 4]),
        };
        const m1 = mapGamepadSnapshot(activeSnap, cfg, m0.nextButtons);
        assert(m1.steerWheelDeg === -540, `Вправо (+1) должно давать -540°, получено ${m1.steerWheelDeg}`);
        assert(m1.throttle === 1 && m1.brake > 0.35 && m1.brake < 0.45, "Неверная нормализация педалей G29");
        assert(m1.gearCommand === "R" && m1.signalToggle === "left", "Не сработали фронт R и левый лепесток");

        // Удержание тех же кнопок на следующем кадре не дублирует переключение (антидребезг)
        const m2 = mapGamepadSnapshot(activeSnap, cfg, m1.nextButtons);
        assert(m2.gearCommand === null && m2.signalToggle === null, "Повторное срабатывание при удержании кнопки");
        return `G29 auto · deadzone OK · axis+1 → ${m1.steerWheelDeg}° · газ ${m1.throttle} / торм ${m1.brake.toFixed(2)} · антидребезг OK`;
      },
    },
    {
      id: "T20",
      suite: "traffic",
      name: "Разъезд со встречным трафиком на своей полосе: 0 касаний и бит-точный реплей",
      fn: () => {
        const world = buildScenarioWorld("city_osm", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        let s = createInitialState(world, true);
        // Ставим ученика строго на свою правую полосу (x = -2.2), навстречу едет поток по x = +2.2
        s = { ...s, x: -2.2, z: -42, h: 0 };
        const startWorld = { ...world, start: { x: -2.2, z: -42, h: 0 } };
        let runState = createInitialState(startWorld, true);
        const rec = new AttemptRecorder(runState, true);

        for (let t = 0; t < 240; t++) {
          const inp = {
            ...createReadyInput("D"),
            signal: t < 60 ? ("left" as const) : null,
            throttle: t < 180 ? 0.55 : 0,
            brake: t >= 180 ? 0.5 : 0,
          };
          const out = stepSimulation(runState, inp, startWorld, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          runState = out.state;
          rec.recordTick(inp, runState, out.newEvents);
        }
        const snap = rec.snapshot(runState, startWorld, DEFAULT_CALIBRATION, DEFAULT_RULESET);
        assert(runState.collisions === 0, `На своей полосе x=-2.2 не должно быть касаний, получено ${runState.collisions}`);
        const rep = replayInputStream(snap.inputStream, startWorld, DEFAULT_CALIBRATION, DEFAULT_RULESET, true);
        assert(
          rep.finalState.x === runState.x && rep.finalState.z === runState.z && rep.events.length === snap.events.length,
          "Нарушен детерминизм реплея при активном трафике"
        );
        return `4 с по правой полосе (${snap.distanceMeters} м): касаний 0, вердикт ${snap.evaluation.verdict}, реплей 100%`;
      },
    },
  ];

  return cases.map((tc) => {
    const t0 = performance.now();
    try {
      const detail = tc.fn();
      return {
        id: tc.id,
        suite: tc.suite,
        name: tc.name,
        passed: true,
        durationMs: Number((performance.now() - t0).toFixed(2)),
        detail,
      };
    } catch (err) {
      return {
        id: tc.id,
        suite: tc.suite,
        name: tc.name,
        passed: false,
        durationMs: Number((performance.now() - t0).toFixed(2)),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
