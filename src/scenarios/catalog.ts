import type { NormalizedOsmPack } from "../maps/osmLoader";
import type {
  CalibrationConfig,
  ObstacleBox,
  ParkedModelKey,
  ParkingBay,
  ScenarioId,
  WorldData,
} from "../sim/types";
import { VEHICLE_DIMS } from "../sim/vehicle";
import { buildCustomWorld, defaultCustomScenario, type CustomScenarioDef } from "./custom";

function makeParkedCarObstacle(bay: ParkingBay, model: ParkedModelKey, color: number): ObstacleBox {
  const dim = VEHICLE_DIMS[model];
  return {
    id: `parked-bay-${bay.id}`,
    kind: "parked_car",
    cx: bay.cx,
    cz: bay.cz,
    halfX: dim.width / 2,
    halfZ: dim.length / 2,
    h: bay.h,
    height: dim.height,
    color,
    model,
    label: `${dim.name} (место №${bay.id})`,
  };
}

/** Сценарий 1: Перпендикулярная парковка задним ходом в бокс (2 ряда A и B по 4 бокса, как в v8). */
export function buildPerpendicularScenario(cal: CalibrationConfig): WorldData {
  const bw = cal.perpBayWidth;
  const bl = cal.perpBayLength;
  const aisle = cal.aisleWidth;
  const stepX = bw + 0.14;

  const occupiedSpec: Record<number, { model: ParkedModelKey; color: number }> = {
    1: { model: "picanto", color: 0xf2c94c },
    3: { model: "xceed", color: 0xe6edf2 },
    6: { model: "rio", color: 0x3b82f6 },
    8: { model: "sorento", color: 0x4b5563 },
  };

  const bays: ParkingBay[] = [];
  const obstacles: ObstacleBox[] = [];

  // Ряд A (номера 1–4): въезд при z = 0, глубина к -Z, нос припаркованной машины к +Z (h = 0)
  for (let col = 0; col < 4; col++) {
    const id = col + 1;
    const cx = (1.5 - col) * stepX;
    const spec = occupiedSpec[id];
    const bay: ParkingBay = {
      id,
      label: `Бокс №${id} (ряд A)`,
      kind: "perpendicular",
      cx,
      cz: -bl / 2,
      width: bw,
      length: bl,
      h: 0,
      openSide: "front",
      occupied: Boolean(spec),
      parkedModel: spec?.model,
      parkedColor: spec?.color,
      requireReverseEntry: true,
    };
    bays.push(bay);
    if (spec) obstacles.push(makeParkedCarObstacle(bay, spec.model, spec.color));
  }

  // Ряд B (номера 5–8): въезд при z = aisle, глубина к +Z, нос к -Z (h = PI)
  for (let col = 0; col < 4; col++) {
    const id = col + 5;
    const cx = (1.5 - col) * stepX;
    const spec = occupiedSpec[id];
    const bay: ParkingBay = {
      id,
      label: `Бокс №${id} (ряд B)`,
      kind: "perpendicular",
      cx,
      cz: aisle + bl / 2,
      width: bw,
      length: bl,
      h: Math.PI,
      openSide: "front",
      occupied: Boolean(spec),
      parkedModel: spec?.model,
      parkedColor: spec?.color,
      requireReverseEntry: true,
    };
    bays.push(bay);
    if (spec) obstacles.push(makeParkedCarObstacle(bay, spec.model, spec.color));
  }

  const totalSpan = stepX * 4 + 1.6;
  // Задние бордюры вынесены ЗА пределы боксов (не заходят внутрь — инвариант v8 п. 2.6)
  obstacles.push(
    {
      id: "curb-row-a",
      kind: "curb",
      cx: 0,
      cz: -bl - 0.24,
      halfX: totalSpan / 2,
      halfZ: 0.18,
      h: 0,
      height: 0.16,
      color: 0x9aa6b2,
      label: "бордюр ряда A",
    },
    {
      id: "curb-row-b",
      kind: "curb",
      cx: 0,
      cz: aisle + bl + 0.24,
      halfX: totalSpan / 2,
      halfZ: 0.18,
      h: 0,
      height: 0.16,
      color: 0x9aa6b2,
      label: "бордюр ряда B",
    },
    // Угловые разметочные конусы у свободного бокса №2
    {
      id: "cone-a2-l",
      kind: "cone",
      cx: bays[1].cx + bw / 2 + 0.12,
      cz: -0.1,
      halfX: 0.14,
      halfZ: 0.14,
      h: 0,
      height: 0.55,
      color: 0xf97316,
      label: "разметочный конус у бокса №2",
    },
    {
      id: "cone-a2-r",
      kind: "cone",
      cx: bays[1].cx - bw / 2 - 0.12,
      cz: -0.1,
      halfX: 0.14,
      halfZ: 0.14,
      h: 0,
      height: 0.55,
      color: 0xf97316,
      label: "разметочный конус у бокса №2",
    }
  );

  // Здания окружения автодрома
  obstacles.push(
    {
      id: "school-bld-1",
      kind: "building",
      cx: 22,
      cz: aisle / 2,
      halfX: 5,
      halfZ: 11,
      h: 0,
      height: 8.5,
      color: 0x4b5c6b,
      label: "учебный корпус автошколы",
    },
    {
      id: "school-bld-2",
      kind: "building",
      cx: -24,
      cz: -8,
      halfX: 6,
      halfZ: 8,
      h: 0,
      height: 11,
      color: 0x566472,
      label: "административное здание",
    }
  );

  // Старт в проезде за боксом №2: ряд A справа по ходу (-Z), удобный заезд в бокс №2 задним ходом (руль вправо D)
  const bay2 = bays[1];
  return {
    scenarioId: "bay_90",
    title: "Бокс 90° задним ходом",
    subtitle: `Боксы ${bw.toFixed(1)} × ${bl.toFixed(1)} м · проезд ${aisle.toFixed(1)} м · свободны №2, 4, 5, 7`,
    examinerBrief:
      "Включите R, поверните руль вправо (D) и плавно заедьте задним ходом в свободный бокс №2 (или №4, 5, 7). Удержите остановку 1,5 с.",
    start: {
      x: bay2.cx - 3.35,
      z: Math.min(aisle - 1.3, Math.max(2.1, aisle * 0.44)),
      h: -Math.PI / 2,
    },
    bays,
    obstacles,
    roads: [
      {
        id: "lot-aisle",
        points: [
          { x: -16, z: aisle / 2 },
          { x: 16, z: aisle / 2 },
        ],
        width: aisle + bl * 2 + 2.5,
        lanes: 1,
        highway: "service",
        name: "Учебная площадка",
      },
    ],
    signals: [],
    speedZones: [],
    crosswalks: [],
    traffic: [],
    checkpoints: [],
    defaultSpeedLimitKmh: 20,
    bounds: { minX: -32, maxX: 32, minZ: -26, maxZ: 32 },
  };
}

/** Сценарий 2: Параллельная парковка задним ходом (порт из v2: места №9–12, заняты №10 и №12). */
export function buildParallelScenario(cal: CalibrationConfig): WorldData {
  const pl = cal.parBayLength;
  const pw = cal.parBayWidth;
  const gap = 0.55;
  const stepZ = pl + gap;
  const bayX = -3.2;

  const occupiedSpec: Record<number, { model: ParkedModelKey; color: number }> = {
    10: { model: "rio", color: 0x3b82f6 },
    12: { model: "xceed", color: 0xe6edf2 },
  };

  const bays: ParkingBay[] = [];
  const obstacles: ObstacleBox[] = [];

  for (let i = 0; i < 4; i++) {
    const id = 9 + i;
    const cz = (i - 1.5) * stepZ;
    const spec = occupiedSpec[id];
    const bay: ParkingBay = {
      id,
      label: `Карман №${id} (параллельный)`,
      kind: "parallel",
      cx: bayX,
      cz,
      width: pw,
      length: pl,
      h: 0,
      openSide: "left",
      occupied: Boolean(spec),
      parkedModel: spec?.model,
      parkedColor: spec?.color,
      requireReverseEntry: true,
    };
    bays.push(bay);
    if (spec) obstacles.push(makeParkedCarObstacle(bay, spec.model, spec.color));
  }

  // Правый бордюр вдоль всего парковочного кармана (не заходит внутрь бокса)
  obstacles.push(
    {
      id: "par-curb-right",
      kind: "curb",
      cx: bayX - pw / 2 - 0.22,
      cz: 0,
      halfX: 0.18,
      halfZ: stepZ * 2.4,
      h: 0,
      height: 0.16,
      color: 0x9aa6b2,
      label: "правый бордюр парковочного кармана",
    },
    {
      id: "par-curb-left",
      kind: "curb",
      cx: 4.4,
      cz: 0,
      halfX: 0.18,
      halfZ: stepZ * 2.4,
      h: 0,
      height: 0.16,
      color: 0x9aa6b2,
      label: "левый бордюр проезжей части",
    },
    {
      id: "par-bld-1",
      kind: "building",
      cx: -13.5,
      cz: 2,
      halfX: 5.5,
      halfZ: 16,
      h: 0,
      height: 12.8,
      color: 0x52616f,
      label: "жилой дом №8",
    },
    {
      id: "par-bld-2",
      kind: "building",
      cx: 13.5,
      cz: -3,
      halfX: 5,
      halfZ: 14,
      h: 0,
      height: 9.6,
      color: 0x4a5968,
      label: "учебный центр",
    }
  );

  // Старт поравнявшись с автомобилем в кармане №12 — карман №11 свободен прямо сзади-справа
  const bay12 = bays[3];
  return {
    scenarioId: "parallel_v2",
    title: "Параллельная парковка (порт v2)",
    subtitle: `Места №9–12 (${pl.toFixed(1)} × ${pw.toFixed(1)} м, предв.) · заняты №10 и №12`,
    examinerBrief:
      "Включите правый поворотник (E), передачу R и припаркуйтесь задним ходом в свободный карман №11 между двумя машинами (или №9).",
    start: {
      x: bayX + pw / 2 + 1.55,
      z: bay12.cz - 0.3,
      h: 0,
    },
    bays,
    obstacles,
    roads: [
      {
        id: "par-street",
        points: [
          { x: 0.6, z: -26 },
          { x: 0.6, z: 26 },
        ],
        width: 7.4,
        lanes: 2,
        highway: "residential",
        name: "ул. Учебная",
        hasSolidCenter: false,
      },
    ],
    signals: [],
    speedZones: [],
    crosswalks: [],
    traffic: [],
    checkpoints: [],
    defaultSpeedLimitKmh: 40,
    bounds: { minX: -24, maxX: 24, minZ: -28, maxZ: 28 },
  };
}

/** Сценарий 3: Городской экзаменационный маршрут на офлайн OSM map pack (или загруженном OSM/GeoJSON). */
export function buildCityOsmScenario(
  cal: CalibrationConfig,
  customPack?: NormalizedOsmPack | null
): WorldData {
  if (customPack && customPack.roads.length > 0) {
    return {
      scenarioId: "city_osm",
      title: customPack.meta.title,
      subtitle: `OSM Pack: дорог ${customPack.meta.roadsCount} · зданий ${customPack.meta.buildingsCount} · светофоров ${customPack.meta.signalsCount}`,
      examinerBrief:
        "Свободный проезд по загруженному участку OSM: соблюдайте скоростной режим, сигналы светофоров и указатели поворота (Q/E).",
      start: customPack.suggestedStart,
      bays: [],
      obstacles: customPack.buildings,
      roads: customPack.roads,
      signals: customPack.signals,
      speedZones: customPack.speedZones,
      crosswalks: customPack.crosswalks,
      traffic: [],
      checkpoints: [],
      defaultSpeedLimitKmh: 60,
      mapMeta: customPack.meta,
      bounds: customPack.bounds,
    };
  }

  // Встроенный эталонный офлайн map pack «Учебный квартал МРЭО» (400 × 400 м)
  const pl = Math.max(6.2, cal.parBayLength);
  const pw = Math.max(2.3, cal.parBayWidth);

  // Финальный парковочный карман на ул. Школьной (z = 64, движение к -X, правая обочина у z = 58.3)
  const pocketZ = 58.3;
  const finalBays: ParkingBay[] = [
    {
      id: 13,
      label: "Место №13 (ул. Школьная)",
      kind: "parallel",
      cx: -48.5,
      cz: pocketZ,
      width: pw,
      length: pl,
      h: -Math.PI / 2,
      openSide: "left",
      occupied: true,
      parkedModel: "picanto",
      parkedColor: 0xf2c94c,
    },
    {
      id: 14,
      label: "Финишный карман №14 (ул. Школьная)",
      kind: "parallel",
      cx: -56.0,
      cz: pocketZ,
      width: pw,
      length: pl + 0.8,
      h: -Math.PI / 2,
      openSide: "left",
      occupied: false,
    },
    {
      id: 15,
      label: "Место №15 (ул. Школьная)",
      kind: "parallel",
      cx: -63.8,
      cz: pocketZ,
      width: pw,
      length: pl,
      h: -Math.PI / 2,
      openSide: "left",
      occupied: true,
      parkedModel: "sorento",
      parkedColor: 0x475569,
    },
  ];

  const obstacles: ObstacleBox[] = [
    makeParkedCarObstacle(finalBays[0], "picanto", 0xf2c94c),
    makeParkedCarObstacle(finalBays[2], "sorento", 0x475569),
    // Бордюр за финишным карманом
    {
      id: "city-finish-curb",
      kind: "curb",
      cx: -56,
      cz: pocketZ - pw / 2 - 0.25,
      halfX: 14,
      halfZ: 0.18,
      h: 0,
      height: 0.16,
      color: 0x9aa6b2,
      label: "бордюр ул. Школьной",
    },
    // Квартальная застройка (OSM building:levels -> высота)
    { id: "osm-b1", kind: "building", cx: -18, cz: -32, halfX: 8, halfZ: 14, h: 0, height: 16, color: 0x4d5d6c, label: "ул. Автозаводская, 4" },
    { id: "osm-b2", kind: "building", cx: 19, cz: -30, halfX: 9, halfZ: 13, h: 0, height: 12.8, color: 0x596673, label: "ул. Автозаводская, 3" },
    { id: "osm-b3", kind: "building", cx: -22, cz: 26, halfX: 9, halfZ: 12, h: 0, height: 19.2, color: 0x495867, label: "пр-т Мира, 12" },
    { id: "osm-b4", kind: "building", cx: 20, cz: 34, halfX: 8, halfZ: 16, h: 0, height: 12.8, color: 0x5c646c, label: "Школа №17" },
    { id: "osm-b5", kind: "building", cx: -24, cz: 82, halfX: 12, halfZ: 8, h: 0, height: 16, color: 0x51606e, label: "ул. Школьная, 9" },
    { id: "osm-b6", kind: "building", cx: -56, cz: 46, halfX: 15, halfZ: 7, h: 0, height: 14.5, color: 0x5a6570, label: "ул. Школьная, 14" },
    { id: "osm-b7", kind: "building", cx: -58, cz: 82, halfX: 14, halfZ: 8, h: 0, height: 22, color: 0x485664, label: "ул. Школьная, 15" },
    { id: "osm-b8", kind: "building", cx: 22, cz: 82, halfX: 10, halfZ: 8, h: 0, height: 9.6, color: 0x566472, label: "здание МРЭО" },
    { id: "osm-b9", kind: "building", cx: -52, cz: -24, halfX: 11, halfZ: 10, h: 0, height: 15, color: 0x4f5e6b, label: "пр-т Мира, 8" },
    { id: "osm-b10", kind: "building", cx: -52, cz: 22, halfX: 10, halfZ: 9, h: 0, height: 12.8, color: 0x58636e, label: "пр-т Мира, 10" },
    { id: "osm-b11", kind: "building", cx: 48, cz: -24, halfX: 10, halfZ: 11, h: 0, height: 18, color: 0x4b5b6a, label: "пр-т Мира, 5" },
    { id: "osm-b12", kind: "building", cx: -92, cz: 64, halfX: 7, halfZ: 16, h: 0, height: 14, color: 0x51606e, label: "пер. Садовый, 2" },
  ];

  return {
    scenarioId: "city_osm",
    title: "Городской маршрут (OSM Pack)",
    subtitle: "Светофор + стоп-линия · знак «40» · пешеходный переход · встречный трафик · поворот направо · парковка",
    examinerBrief:
      "Включите левый поворотник (Q), начните движение по ул. Автозаводской и следуйте заданиям экзаменатора.",
    start: { x: -2.2, z: -50, h: 0 },
    bays: finalBays,
    obstacles,
    roads: [
      {
        id: "osm-way-101",
        points: [
          { x: 0, z: -68 },
          { x: 0, z: 96 },
        ],
        width: 9.0,
        lanes: 2,
        highway: "secondary",
        name: "ул. Автозаводская",
        hasSolidCenter: true,
        speedLimitKmh: 60,
      },
      {
        id: "osm-way-102",
        points: [
          { x: -82, z: 0 },
          { x: 74, z: 0 },
        ],
        width: 10.0,
        lanes: 2,
        highway: "primary",
        name: "пр-т Мира",
        hasSolidCenter: true,
        speedLimitKmh: 60,
      },
      {
        id: "osm-way-103",
        points: [
          { x: 54, z: 64 },
          { x: -82, z: 64 },
        ],
        width: 8.8,
        lanes: 2,
        highway: "residential",
        name: "ул. Школьная",
        hasSolidCenter: true,
        speedLimitKmh: 40,
      },
    ],
    // Детерминированный трафик: только в полосах ПРОТИВУ ученика (правостороннее движение).
    // Ученик едет север по правой полосе ул. Автозаводской (x = -2.2);
    // встречные машины южнее по их правой полосе x = +2.2.
    traffic: [
      {
        id: "traffic-avto-south-1",
        points: [
          { x: 2.2, z: 96 },
          { x: 2.2, z: -68 },
        ],
        speed: 9.2,
        dir: 1,
        offset: 60,
        model: "rio",
      },
      {
        id: "traffic-avto-south-2",
        points: [
          { x: 2.2, z: 96 },
          { x: 2.2, z: -68 },
        ],
        speed: 7.6,
        dir: 1,
        offset: 132,
        model: "picanto",
      },
      {
        id: "traffic-mira-east",
        points: [
          { x: -74, z: 2.4 },
          { x: 66, z: 2.4 },
        ],
        speed: 8.3,
        dir: 1,
        offset: 40,
        model: "ceed",
      },
      {
        id: "traffic-shkolnaya-east",
        points: [
          { x: -78, z: 66.4 },
          { x: 50, z: 66.4 },
        ],
        speed: 8.0,
        dir: 1,
        offset: 90,
        model: "sorento",
      },
    ],
    signals: [
      {
        id: "sig-mira-north",
        x: -5.4,
        z: -6.8,
        h: 0,
        stopLineX: -2.25,
        stopLineZ: -7.5,
        stopLineWidth: 4.5,
        cycleOffset: 15, // при подъезде ученик видит смену фазы и реальную работу стоп-линии
        greenDuration: 13,
        redDuration: 11,
      },
      {
        id: "sig-shkolnaya-east",
        x: -34,
        z: 58.6,
        h: -Math.PI / 2,
        stopLineX: -32.5,
        stopLineZ: 61.8,
        stopLineWidth: 4.4,
        cycleOffset: 4,
        greenDuration: 15,
        redDuration: 9,
      },
    ],
    speedZones: [
      {
        id: "zone-school-40",
        x: 0,
        z: 38,
        signX: -5.4,
        signZ: 18,
        radius: 24,
        limitKmh: 40,
        label: "Знак 3.24 «40 км/ч» (Школа №17)",
      },
    ],
    crosswalks: [
      {
        id: "cw-school-17",
        cx: 0,
        cz: 36,
        width: 9.0,
        length: 3.8,
        h: 0,
        pedSpeed: 1.35,
        pedPhaseOffset: 2.0,
      },
    ],
    checkpoints: [
      {
        id: "cp-1",
        x: -2.2,
        z: -24,
        radius: 6.5,
        instruction: "Начните движение с левым поворотником (Q) и подъезжайте к перекрёстку с пр-том Мира.",
      },
      {
        id: "cp-2",
        x: -2.2,
        z: 12,
        radius: 7.0,
        instruction: "Проедьте регулируемый перекрёсток прямо на зелёный сигнал (на красный — остановитесь до стоп-линии).",
      },
      {
        id: "cp-3",
        x: -2.2,
        z: 48,
        radius: 7.0,
        instruction: "Соблюдайте знак «40» и уступите пешеходу на переходе у Школы №17.",
      },
      {
        id: "cp-4",
        x: -16,
        z: 61.8,
        radius: 7.5,
        requireSignal: "right",
        instruction: "Включите правый поворотник (E) и поверните направо на ул. Школьную.",
      },
      {
        id: "cp-5",
        x: -56,
        z: pocketZ,
        radius: 5.0,
        isFinalPark: true,
        instruction: "Проедьте светофор и припаркуйтесь в свободном кармане №14 справа (между двумя автомобилями).",
      },
    ],
    defaultSpeedLimitKmh: 60,
    mapMeta: {
      id: "mreo-demo-pack-v1",
      title: "Офлайн Map Pack «Учебный квартал МРЭО» v1.0",
      source: "Предсобранный офлайн-пакет (без runtime-запросов к Overpass API)",
      attribution: "© OpenStreetMap contributors",
      license: "ODbL 1.0 (Produced Work + атрибуция)",
      extractedAt: "2026-03-01",
      bbox: [37.6142, 55.7012, 37.6218, 55.7064],
      roadsCount: 3,
      buildingsCount: 12,
      signalsCount: 2,
    },
    bounds: { minX: -84, maxX: 74, minZ: -70, maxZ: 98 },
  };
}

export function buildScenarioWorld(
  id: ScenarioId,
  cal: CalibrationConfig,
  customPack?: NormalizedOsmPack | null,
  customDef?: CustomScenarioDef | null
): WorldData {
  if (id === "bay_90") return buildPerpendicularScenario(cal);
  if (id === "parallel_v2") return buildParallelScenario(cal);
  if (id === "custom") return buildCustomWorld(customDef ?? defaultCustomScenario());
  return buildCityOsmScenario(cal, customPack);
}
