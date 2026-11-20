/**
 * @module sim/playerCar
 * @layer pure-core
 * @role Парк автомобилей игрока (Picanto, Rio, Ceed, XCeed, Sorento): реальные габариты, база, колея, Vmax и тяга, привязанные к сценарию.
 * @invariants #1 (координаты и единицы СИ), #7 (чистое ядро — без DOM, `window` и Three.js), #10 (руль ±540°, выворот 33–42°).
 * @tests T38 (`src/sim/selfTestExtra.ts`) — пропорции, динамика и различия машин.
 *
 * До появления выбора автомобиля физика брала единственный паспорт `CAR` (Kia Ceed JD)
 * из `sim/vehicle.ts`. Теперь сценарий задаёт машину игрока (`WorldData.playerCarId`),
 * а ядро умножает безразмерные коэффициенты на базовые константы Ceed:
 * - `accelScale` — тяговое ускорение (момент/масса),
 * - `brakeScale` — эффективность тормозов,
 * - `vmaxKmh` — электронный ограничитель скорости,
 * - `creepKmh` — равновесная скорость самохода гидротрансформатора на D1.
 *
 * Геометрия (длина, ширина, база, колея, свесы, радиус колеса) влияет на Аккермана,
 * радиус разворота, клиренс в боксах и скорость вращения колёс, поэтому паспорт
 * хранится здесь целиком, а не только коэффициенты.
 */
import type { PlayerCarId } from "./types";

export type { PlayerCarId };

/** Назначение машины: влияет только на подсказки в интерфейсе. */
export type PlayerCarClass = "city" | "compact" | "wagon" | "crossover" | "suv";

export type PlayerCarSpec = {
  id: PlayerCarId;
  /** Полное имя для карточки выбора: марка, модель и поколение. */
  name: string;
  /** Короткая подпись для HUD (например, «Ceed JD»). */
  shortName: string;
  className: PlayerCarClass;
  label: string;
  engine: string;
  gearbox: string;
  /** Габариты кузова, м. */
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  track: number;
  frontOverhang: number;
  rearOverhang: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Максимальный предел внутреннего колеса, °. */
  maxInnerDeg: number;
  /** Паспортная максимальная скорость, км/ч (электронный ограничитель). */
  vmaxKmh: number;
  /** 0–100 км/ч, с (паспорт) — для карточки и проверки динамики в самотесте. */
  accel0to100: number;
  /** Тяговое ускорение на 1-й передаче при полке момента, м/с². */
  peakAccel: number;
  /** Равновесная скорость самохода D1 на холостых, км/ч. */
  creepKmh: number;
  /** Множитель тормозного замедления относительно Ceed (масса/тормоза). */
  brakeScale: number;
  /** Размерность/профиль шин для карточки. */
  tyres: string;
  /** Цвет кузова игрока (0xRRGGBB). */
  color: number;
  /** Краткая характеристика для карточки выбора. */
  blurb: string;
};

/**
 * Парк игрока. Все числа — паспортные данные соответствующих Kia (кат. B):
 * Picanto TA 1.2, Rio FB 1.6, Ceed JD 1.6, XCeed CD 1.6 T-GDI, Sorento MQ4 2.5.
 */
export const PLAYER_CARS: readonly PlayerCarSpec[] = [
  {
    id: "picanto",
    name: "Kia Picanto TA",
    shortName: "Picanto",
    className: "city",
    label: "Городской хэтчбек · кат. B",
    engine: "1.2 MPI · 84 л.с.",
    gearbox: "4АКПП",
    length: 3.595,
    width: 1.595,
    height: 1.485,
    wheelbase: 2.4,
    track: 1.406,
    frontOverhang: 0.68,
    rearOverhang: 0.515,
    wheelRadius: 0.279,
    wheelWidth: 0.175,
    maxInnerDeg: 38,
    vmaxKmh: 160,
    accel0to100: 13.7,
    peakAccel: 3.05,
    creepKmh: 5.6,
    brakeScale: 0.94,
    tyres: "175/65 R14",
    color: 0xf2c94c,
    blurb: "Самый компактный: минимальный радиус разворота, лучший выбор для парковки в узких боксах.",
  },
  {
    id: "rio",
    name: "Kia Rio FB",
    shortName: "Rio",
    className: "compact",
    label: "Седан · кат. B",
    engine: "1.6 MPI · 123 л.с.",
    gearbox: "6АКПП",
    length: 4.4,
    width: 1.74,
    height: 1.47,
    wheelbase: 2.6,
    track: 1.517,
    frontOverhang: 0.84,
    rearOverhang: 0.96,
    wheelRadius: 0.305,
    wheelWidth: 0.195,
    maxInnerDeg: 36,
    vmaxKmh: 190,
    accel0to100: 11.4,
    peakAccel: 3.5,
    creepKmh: 5.2,
    brakeScale: 1,
    tyres: "185/65 R15",
    color: 0x3b82f6,
    blurb: "Седан с 6АКПП: уверенная динамика и длинный багажник — сложнее в узких карманах.",
  },
  {
    id: "ceed",
    name: "Kia Ceed JD",
    shortName: "Ceed JD",
    className: "wagon",
    label: "Хэтчбек · кат. B",
    engine: "1.6 MPI · 130 л.с.",
    gearbox: "6АКПП Shiftronic",
    length: 4.31,
    width: 1.8,
    height: 1.447,
    wheelbase: 2.65,
    track: 1.57,
    frontOverhang: 0.88,
    rearOverhang: 0.78,
    wheelRadius: 0.315,
    wheelWidth: 0.215,
    maxInnerDeg: 35,
    vmaxKmh: 180,
    accel0to100: 10.8,
    peakAccel: 4.08,
    creepKmh: 5,
    brakeScale: 1,
    tyres: "205/55 R16",
    color: 0xd97706,
    blurb: "Учебная машина школы: эталонная база 2,65 м и 6АКПП Shiftronic с ручным пазом M1–M6.",
  },
  {
    id: "xceed",
    name: "Kia XCeed CD",
    shortName: "XCeed",
    className: "crossover",
    label: "Кроссовер · кат. B",
    engine: "1.6 T-GDI · 150 л.с.",
    gearbox: "7DCT",
    length: 4.395,
    width: 1.826,
    height: 1.495,
    wheelbase: 2.65,
    track: 1.573,
    frontOverhang: 0.9,
    rearOverhang: 0.845,
    wheelRadius: 0.331,
    wheelWidth: 0.225,
    maxInnerDeg: 34.5,
    vmaxKmh: 205,
    accel0to100: 9.2,
    peakAccel: 4.6,
    creepKmh: 4.6,
    brakeScale: 1.06,
    tyres: "225/45 R18",
    color: 0xe6edf2,
    blurb: "Кроссовер с турбонаддувом: высокая посадка, острый руль и короткий ход подвески на стыках.",
  },
  {
    id: "sorento",
    name: "Kia Sorento MQ4",
    shortName: "Sorento",
    className: "suv",
    label: "Среднеразмерный SUV · кат. B",
    engine: "2.5 GDI · 180 л.с.",
    gearbox: "8АКПП",
    length: 4.81,
    width: 1.9,
    height: 1.7,
    wheelbase: 2.815,
    track: 1.646,
    frontOverhang: 0.94,
    rearOverhang: 1.055,
    wheelRadius: 0.353,
    wheelWidth: 0.235,
    maxInnerDeg: 33,
    vmaxKmh: 210,
    accel0to100: 9.1,
    peakAccel: 4.2,
    creepKmh: 4.4,
    brakeScale: 1.15,
    tyres: "235/55 R19",
    color: 0x4b5563,
    blurb: "Большой SUV: почти 4,8 м длины — требует площадки, зато уверенно тормозит на скорости.",
  },
];

/** Машина по умолчанию — учебный Ceed JD: паспорт побитно совместим со старыми записями реплеев. */
export const DEFAULT_PLAYER_CAR_ID: PlayerCarId = "ceed";

export function getPlayerCar(id: string | null | undefined): PlayerCarSpec {
  if (!id) return PLAYER_CARS[2];
  return PLAYER_CARS.find((c) => c.id === id) ?? PLAYER_CARS[2];
}

/** Безразмерные коэффициенты физики относительно базового паспорта Ceed (см. `sim/vehicle.ts`). */
export type PlayerCarPhysics = {
  accelScale: number;
  brakeScale: number;
  vmaxKmh: number;
  creepKmh: number;
  wheelbase: number;
  track: number;
  length: number;
  width: number;
  height: number;
  frontOverhang: number;
  rearOverhang: number;
  wheelRadius: number;
  maxInnerDeg: number;
};

export function playerCarPhysics(id: string | null | undefined): PlayerCarPhysics {
  const c = getPlayerCar(id);
  return {
    accelScale: c.peakAccel / 4.08,
    brakeScale: c.brakeScale,
    vmaxKmh: c.vmaxKmh,
    creepKmh: c.creepKmh,
    wheelbase: c.wheelbase,
    track: c.track,
    length: c.length,
    width: c.width,
    height: c.height,
    frontOverhang: c.frontOverhang,
    rearOverhang: c.rearOverhang,
    wheelRadius: c.wheelRadius,
    maxInnerDeg: c.maxInnerDeg,
  };
}
