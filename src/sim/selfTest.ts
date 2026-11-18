/**
 * @module sim/selfTest
 * @layer pure-core
 * @role Главный набор и раннер автотестов чистого ядра (`runAllSelfTests`: T01–T16, T18, T20, T21 + `extraCases`).
 * @invariants #7 (исполняется и в чистом Node.js, и в браузере без DOM/Three.js).
 */
import { summarizeAttempts, attemptsToCsv, studentOf } from "../analytics/summary";
import {
  DECISIONS,
  NEXT_ACTIONS,
  PRIORITIES,
  PRINCIPLES,
  STRATEGY_PHASES,
  strategyToMarkdown,
} from "../strategy/plan";
import { parseOsmOrGeoJson } from "../maps/osmLoader";
import { buildRouteFromRoads, streetNameAt } from "../maps/route";
import { buildScenarioWorld } from "../scenarios/catalog";
import { buildCustomWorld, defaultCustomScenario, validateCustomScenario } from "../scenarios/custom";
import { DEFAULT_CALIBRATION, DEFAULT_RULESET, evaluateAttempt } from "../scoring/rules";
import { buildGoldenSet } from "./golden";
import { extraCases } from "./selfTestExtra";
import { AttemptRecorder, replayInputStream } from "./recorder";
import { checkCarCollisionBruteForce, isCarInsideBay, SpatialGrid } from "./spatialGrid";
import { createInitialInput, createInitialState, createReadyInput, stepSimulation } from "./step";
import type { RoadSegment, SimEvent } from "./types";
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
      id: "T18",
      suite: "analytics",
      name: "Статистика учеников: доля сдавших, топ нарушений и CSV-отчёт",
      fn: () => {
        const world = buildScenarioWorld("bay_90", DEFAULT_CALIBRATION);
        const grid = new SpatialGrid(world.obstacles, 10);
        let state = createInitialState(world, false);
        const rec = new AttemptRecorder(state, false);
        for (let t = 0; t < 90; t++) {
          const inp = { ...createReadyInput("R"), belt: false, throttle: t < 60 ? 0.5 : 0 };
          const out = stepSimulation(state, inp, world, grid, DEFAULT_CALIBRATION, DEFAULT_RULESET, FIXED_DT);
          state = out.state;
          rec.recordTick(inp, state, out.newEvents);
        }
        const base = rec.snapshot(state, world, DEFAULT_CALIBRATION, DEFAULT_RULESET);
        assert(base.events.some((e) => e.code === "belt_unfastened"), "Тестовая попытка должна содержать нарушение");

        const passed = { ...base, id: "a1", student: "Иванов И.", createdAt: "2026-03-01T10:00:00.000Z" };
        const lineEvent = {
          id: "line-1",
          code: "line_cross" as const,
          tick: 50,
          time: 0.8,
          x: 0,
          z: 0,
          h: 0,
          speedKmh: 3,
          detail: "Наезд на линию",
        };
        const failedEvents = [...base.events, lineEvent];
        const failed = {
          ...base,
          id: "a2",
          student: "Петров П.",
          createdAt: "2026-03-02T10:00:00.000Z",
          events: failedEvents,
          evaluation: evaluateAttempt(failedEvents, 0, DEFAULT_RULESET),
        };
        const unnamed = { ...base, id: "a3", student: undefined, createdAt: "2026-03-03T10:00:00.000Z" };

        const summary = summarizeAttempts([passed, failed, unnamed], DEFAULT_RULESET);
        assert(summary.total === 3 && summary.passed === 2 && summary.failed === 1, "Неверный баланс сдал/не сдал");
        assert(Math.abs(summary.passRate - 66.7) < 0.1, `Доля сдавших ${summary.passRate}% вместо 66.7%`);
        assert(summary.students.length === 3, "Должно быть 3 ученика, включая «Без имени»");
        assert(studentOf(unnamed) === "Без имени", "Пустое имя должно попадать в «Без имени»");
        const belt = summary.violations.find((v) => v.code === "belt_unfastened");
        assert(Boolean(belt) && belt!.count === 3, "Нарушение по ремню должно встречаться 3 раза");
        for (let i = 1; i < summary.violations.length; i++) {
          assert(
            summary.violations[i - 1].count >= summary.violations[i].count,
            "Нарушения должны быть отсортированы по частоте"
          );
        }

        const csv = attemptsToCsv([passed, failed], DEFAULT_RULESET);
        assert(csv.split("\r\n").length === 3, "CSV должен содержать шапку и 2 строки");
        assert(csv.includes("Иванов И.") && csv.includes("НЕ СДАЛ"), "В CSV нет ученика или вердикта");
        return `3 попытки · ${summary.passRate}% сдано · нарушений ${summary.violations.length} · CSV ${csv.split("\r\n").length} строки`;
      },
    },
    {
      id: "T20",
      suite: "strategy",
      name: "Стратегия: фазы, принципы, приоритеты и Markdown-экспорт согласованы",
      fn: () => {
        assert(STRATEGY_PHASES.length === 6, `Ожидалось 6 фаз, получено ${STRATEGY_PHASES.length}`);
        const statuses = STRATEGY_PHASES.map((p) => p.status);
        assert(statuses.filter((s) => s === "done").length === 3, "Фазы 0, 2 и 3 должны быть завершены");
        assert(statuses.includes("active") && statuses.includes("next") && statuses.includes("later"), "Нет активных/следующих фаз");
        for (const p of STRATEGY_PHASES) {
          assert(p.goal.length > 0 && p.metric.length > 0, `Фаза ${p.num}: нет цели или метрики`);
          assert(p.done.length + p.remaining.length > 0, `Фаза ${p.num}: пустой состав`);
        }
        assert(PRINCIPLES.length >= 6, "Должно быть не меньше 6 принципов");
        assert(PRIORITIES.length === 4, "Нужны 4 корзины приоритетов");
        const never = PRIORITIES.find((b) => b.id === "never");
        assert(Boolean(never) && never!.items.some((i) => i.includes("Серверная")), "В «Не делаем» должен быть сервер");
        assert(DECISIONS.length >= 6 && NEXT_ACTIONS.length >= 6, "Журнал решений и действия слишком короткие");
        const md = strategyToMarkdown();
        assert(md.includes("# CityDrivingTraining — стратегия"), "Markdown без заголовка");
        assert(md.includes("## Принципы") && md.includes("## Фазы") && md.includes("## Журнал решений"), "Markdown неполный");
        assert(md.includes("Учебная симуляция"), "Markdown потерял дисклеймер");
        return `фаз ${STRATEGY_PHASES.length} (3 завершено) · принципов ${PRINCIPLES.length} · решений ${DECISIONS.length} · действий ${NEXT_ACTIONS.length}`;
      },
    },
    {
      id: "T21",
      suite: "route",
      name: "Маршрут по реальной дороге: точки на геометрии, название улицы, старт справа",
      fn: () => {
        const roads: RoadSegment[] = [
          {
            id: "r1",
            points: [{ x: 0, z: 0 }, { x: 0, z: 120 }],
            width: 9,
            lanes: 2,
            highway: "secondary",
            name: "ул. Автозаводская",
            speedLimitKmh: 40,
          },
          {
            id: "r2",
            points: [{ x: -40, z: 0 }, { x: 40, z: 0 }],
            width: 7,
            lanes: 2,
            highway: "residential",
            name: "пер. Тестовый",
          },
          { id: "r3", points: [{ x: 10, z: 10 }, { x: 10, z: 14 }], width: 6, lanes: 1, highway: "service" },
        ];

        const route = buildRouteFromRoads(roads, { spacing: 24 });
        assert(route.roadName === "ул. Автозаводская", `Выбрана другая улица: «${route.roadName}»`);
        assert(route.speedLimitKmh === 40, `Ограничение ${route.speedLimitKmh} вместо 40`);
        assert(route.checkpoints.length >= 4 && route.checkpoints.length <= 6, `Точек: ${route.checkpoints.length}`);
        for (const cp of route.checkpoints) {
          assert(Math.abs(cp.x) < 6, `Точка «${cp.id}» вне дороги: x=${cp.x}`);
          assert(cp.z > 0 && cp.z < 120, `Точка «${cp.id}» вне отрезка дороги: z=${cp.z}`);
          assert(cp.instruction.includes("Автозаводская"), `В задании нет названия улицы: ${cp.instruction}`);
          assert(cp.instruction.includes("40 км/ч"), `В задании нет ограничения: ${cp.instruction}`);
        }
        const lastCp = route.checkpoints[route.checkpoints.length - 1];
        assert(!lastCp.isFinalPark, "Финиш маршрута не должен требовать парковку");
        assert(lastCp.instruction.includes("Финиш"), "Последняя точка — не финиш маршрута");

        // Старт: позади первой точки, справа от осевой (правостороннее движение: -X)
        assert(Boolean(route.startPose), "Нет стартовой позы маршрута");
        assert(route.startPose!.z < route.checkpoints[0].z, "Старт должен быть позади первой точки");
        assert(route.startPose!.x < 0, `Старт должен быть справа от осевой, получено x=${route.startPose!.x}`);
        assert(Math.abs(route.startPose!.h) < 0.05, `Курс должен смотреть вдоль дороги, h=${route.startPose!.h}`);

        // Текущая улица в HUD
        assert(streetNameAt(1, 40, roads, 18)?.name === "ул. Автозаводская", "Не нашлась улица под машиной");
        assert(streetNameAt(-40, 3, roads, 18)?.name === "пер. Тестовый", "Не нашлась перекрёстная улица");
        assert(streetNameAt(300, 300, roads, 18) === null, "Ложная улица в точке вне дорог");

        // Импорт реального участка OSM даёт маршрут автоматически
        const sample = {
          elements: [
            { type: "node", id: 1, lat: 55.75, lon: 37.61 },
            { type: "node", id: 2, lat: 55.751, lon: 37.61 },
            {
              type: "way",
              id: 10,
              nodes: [1, 2],
              tags: { highway: "secondary", name: "ул. Тестовая", maxspeed: "40" },
            },
          ],
        };
        const pack = parseOsmOrGeoJson(sample, "Маршрутный участок");
        assert(pack.routeRoadName === "ул. Тестовая", `Импорт: маршрут по «${pack.routeRoadName}»`);
        assert(pack.routeCheckpoints.length >= 3, `Импорт: точек ${pack.routeCheckpoints.length}`);
        assert(
          pack.routeCheckpoints.every((c) => c.instruction.includes("Тестовая")),
          "В импортном маршруте нет названия улицы"
        );
        return `«${route.roadName}»: ${route.checkpoints.length} т. · старт (x ${route.startPose!.x}, h ${route.startPose!.h}) · импорт: ${pack.routeCheckpoints.length} т. по «${pack.routeRoadName}»`;
      },
    },
    ...extraCases,
  ];
  cases.sort((a, b) => a.id.localeCompare(b.id));

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
