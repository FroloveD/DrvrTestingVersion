/**
 * @module maps/routeCheck
 * @layer pure-core
 * @role Комплексная проверка маршрута после импорта OSM и в редакторе: связность по дорожной сети, попадание в произвольную границу, проходимость КТ и старта.
 * @invariants #1 (координаты +Z север, +X лево), #7 (чистое ядро без DOM и three), #8 (офлайн).
 * @tests T30
 */
import { isCarInsideBay, SpatialGrid } from "../sim/spatialGrid";
import type {
  CrosswalkDef,
  ObstacleBox,
  ParkingBay,
  RoadSegment,
  RoadSignDef,
  RouteCheckpoint,
  TrafficSignalDef,
  Vec2,
  WorldBounds,
} from "../sim/types";
import { closestPointOnSegment, isInsideWorldBoundary, isSimplePolygon, isValidBoundaryPolygon } from "./boundary";
import { findRoadNetworkPath, nearestRoadPoint, samplePolyline } from "./route";

export type RouteCheckTarget =
  | { kind: "start" }
  | { kind: "checkpoint"; id: string }
  | { kind: "obstacle"; id: string }
  | { kind: "bay"; id: number }
  | { kind: "boundary" };

export type RouteIssue = {
  severity: "error" | "warning" | "info";
  message: string;
  target?: RouteCheckTarget;
};

export type RouteLegStatus = "ok" | "offroad" | "blocked" | "outside";

export type RouteLegReport = {
  index: number;
  fromLabel: string;
  toLabel: string;
  checkpointId: string;
  status: RouteLegStatus;
  connectedOnRoads: boolean;
  lengthM: number;
  roadNames: string[];
  blockedBy?: string;
  /** Ломаная участка (по реальной дороге OSM или по прямой при разрыве) для отрисовки на 2D-карте. */
  path: Vec2[];
};

export type RouteCheckInput = {
  start: { x: number; z: number; h: number };
  roads?: readonly RoadSegment[];
  checkpoints: readonly RouteCheckpoint[];
  bays: readonly ParkingBay[];
  obstacles: readonly ObstacleBox[];
  signs?: readonly RoadSignDef[];
  signals?: readonly TrafficSignalDef[];
  crosswalks?: readonly CrosswalkDef[];
  bounds: WorldBounds;
  boundaryPolygon?: readonly Vec2[];
  useLotSurface?: boolean;
};

export type RouteCheckReport = {
  ok: boolean;
  status: "valid" | "warnings" | "errors" | "empty";
  summary: string;
  totalLengthM: number;
  estimatedDurationSec: number;
  checkpointsCount: number;
  connectedLegsCount: number;
  freeBaysCount: number;
  signalsOnRoute: number;
  crosswalksOnRoute: number;
  signsOnRoute: number;
  /** Полная осевая линия маршрута по дорогам (используется для построения коридора границы). */
  fullSpine: Vec2[];
  legs: RouteLegReport[];
  issues: RouteIssue[];
  /** Можно ли автоматически починить найденные проблемы кнопкой «Исправить маршрут». */
  canAutoFix: boolean;
};

function angleDiffRad(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function minDistToPolyline(px: number, pz: number, poly: readonly Vec2[]): number {
  let bestSq = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d2 = closestPointOnSegment(px, pz, poly[i].x, poly[i].z, poly[i + 1].x, poly[i + 1].z).distSq;
    if (d2 < bestSq) bestSq = d2;
  }
  return Math.sqrt(bestSq);
}

/** Проверяет, есть ли внутри круга контрольной точки хотя бы одна бесконтактная поза автомобиля. */
function isCheckpointReachable(cp: RouteCheckpoint, heading: number, grid: SpatialGrid): { ok: boolean; blocker?: ObstacleBox } {
  const first = grid.queryCarHit(cp.x, cp.z, heading);
  if (!first.hit) return { ok: true };

  // Проверяем 8 смещений внутри радиуса КТ (например, правая/левая полоса при островке в центре)
  const step = Math.max(0.8, cp.radius * 0.58);
  for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4;
    const tx = cp.x + Math.sin(ang) * step;
    const tz = cp.z + Math.cos(ang) * step;
    if (!grid.queryCarHit(tx, tz, heading).hit) return { ok: true };
  }
  return { ok: false, blocker: first.hit };
}

/** Проверяет проходимость участка вдоль ломаной дороги (ищет препятствие, полностью перегородившее проезд). */
function findLegBlocker(path: readonly Vec2[], grid: SpatialGrid, roadWidth = 7): ObstacleBox | null {
  if (path.length < 2) return null;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
  }
  if (total < 4) return null;

  const sampleStep = Math.max(4, Math.min(10, total / 18));
  const latShift = Math.min(2.6, Math.max(1.2, roadWidth * 0.24));

  for (let d = 2.5; d < total - 2.5; d += sampleStep) {
    const sp = samplePolyline(path, d);
    const rx = -Math.cos(sp.h) * latShift;
    const rz = Math.sin(sp.h) * latShift;
    // Сначала проверяем правую полосу, затем ось и левую полосу (объезд одиночного препятствия)
    const rightHit = grid.queryCarHit(sp.x + rx, sp.z + rz, sp.h).hit;
    if (!rightHit) continue;
    const centerHit = grid.queryCarHit(sp.x, sp.z, sp.h).hit;
    if (!centerHit) continue;
    const leftHit = grid.queryCarHit(sp.x - rx, sp.z - rz, sp.h).hit;
    if (!leftHit) continue;
    return rightHit;
  }
  return null;
}

/**
 * Выполняет полную проверку маршрута и геометрии проезда (как после импорта OSM, так и при ручной правке).
 */
export function checkScenarioRoute(input: RouteCheckInput): RouteCheckReport {
  const issues: RouteIssue[] = [];
  const legs: RouteLegReport[] = [];
  const streetRoads = (input.roads ?? []).filter((r) => r.id !== "custom-lot" && r.points.length >= 2);
  const freeBays = input.bays.filter((b) => !b.occupied);
  const hasPoly = isValidBoundaryPolygon(input.boundaryPolygon);
  const poly = hasPoly ? input.boundaryPolygon : undefined;
  let canAutoFix = false;

  // 1. Проверка самой границы участка (произвольного полигона или прямоугольника)
  if (input.boundaryPolygon && input.boundaryPolygon.length > 0 && !hasPoly) {
    issues.push({
      severity: "error",
      message: "Произвольная граница слишком мала или содержит менее 3 вершин.",
      target: { kind: "boundary" },
    });
    canAutoFix = true;
  } else if (poly && !isSimplePolygon(poly)) {
    issues.push({
      severity: "warning",
      message: "Рёбра произвольной границы пересекаются между собой — расправьте вершины или перестройте коридор.",
      target: { kind: "boundary" },
    });
    canAutoFix = true;
  }
  if (input.bounds.minX >= input.bounds.maxX || input.bounds.minZ >= input.bounds.maxZ) {
    issues.push({
      severity: "error",
      message: "Границы участка заданы неверно (min ≥ max).",
      target: { kind: "boundary" },
    });
    canAutoFix = true;
  }

  const grid = new SpatialGrid(input.obstacles, 10);

  // 2. Проверка стартовой позиции автомобиля
  if (!isInsideWorldBoundary(input.start.x, input.start.z, input.bounds, poly)) {
    issues.push({
      severity: "error",
      message: hasPoly
        ? "Стартовая позиция автомобиля оказалась за пределами произвольной границы маршрута."
        : "Стартовая позиция автомобиля находится за границами карты.",
      target: { kind: "start" },
    });
    canAutoFix = true;
  }

  const startHit = grid.queryCarHit(input.start.x, input.start.z, input.start.h);
  if (startHit.hit) {
    issues.push({
      severity: "warning",
      message: `На старте кузов задевает «${startHit.hit.label || startHit.hit.id}» — сдвиньте старт или нажмите «Исправить маршрут».`,
      target: { kind: "start" },
    });
    canAutoFix = true;
  }

  if (streetRoads.length > 0 && input.useLotSurface === false) {
    const startRoad = nearestRoadPoint(input.start.x, input.start.z, streetRoads);
    if (startRoad && startRoad.dist > startRoad.road.width * 0.65 + 4) {
      issues.push({
        severity: "warning",
        message: `Старт удалён от ближайшей дороги на ${startRoad.dist.toFixed(1)} м.`,
        target: { kind: "start" },
      });
      canAutoFix = true;
    }
  }

  // 3. Если контрольных точек нет — проверяем парковочные боксы или предлагаем автомаршрут по OSM
  const cps = input.checkpoints;
  if (cps.length === 0) {
    if (streetRoads.length > 0) {
      canAutoFix = true;
      issues.push({
        severity: freeBays.length > 0 ? "info" : "warning",
        message:
          freeBays.length > 0
            ? `Загружено дорог: ${streetRoads.length}, свободных боксов: ${freeBays.length}. Контрольные точки маршрута не заданы.`
            : `Загружено дорог: ${streetRoads.length}, но контрольные точки маршрута отсутствуют — нажмите «Автомаршрут» или расставьте точки КТ вручную.`,
      });
    } else if (freeBays.length === 0) {
      issues.push({
        severity: "error",
        message: "На карте нет ни контрольных точек маршрута, ни свободных парковочных боксов.",
      });
    }

    const hasErr = issues.some((i) => i.severity === "error");
    const hasWarn = issues.some((i) => i.severity === "warning");
    return {
      ok: !hasErr && freeBays.length > 0,
      status: hasErr ? "errors" : freeBays.length > 0 ? (hasWarn ? "warnings" : "valid") : "empty",
      summary:
        freeBays.length > 0
          ? `Площадочное упражнение без КТ: свободных боксов ${freeBays.length}.`
          : streetRoads.length > 0
            ? "Контрольные точки не заданы — нажмите «Автомаршрут», чтобы построить маршрут по улице OSM."
            : "Добавьте точки маршрута (КТ), дороги или парковочные боксы.",
      totalLengthM: 0,
      estimatedDurationSec: 0,
      checkpointsCount: 0,
      connectedLegsCount: 0,
      freeBaysCount: freeBays.length,
      signalsOnRoute: 0,
      crosswalksOnRoute: 0,
      signsOnRoute: 0,
      fullSpine: [{ x: input.start.x, z: input.start.z }],
      legs: [],
      issues,
      canAutoFix,
    };
  }

  // 4. Проверка направления старта к КТ #1 и наложения на КТ #1
  const cp0 = cps[0];
  const distToCp0 = Math.hypot(cp0.x - input.start.x, cp0.z - input.start.z);
  if (distToCp0 <= cp0.radius && !cp0.isFinalPark) {
    issues.push({
      severity: "warning",
      message: "Автомобиль стартует уже внутри зоны КТ #1 — точка засчитается мгновенно без движения.",
      target: { kind: "start" },
    });
    canAutoFix = true;
  } else if (distToCp0 > 1) {
    const bearingToCp0 = Math.atan2(cp0.x - input.start.x, cp0.z - input.start.z);
    const diffDeg = Math.abs((angleDiffRad(input.start.h, bearingToCp0) * 180) / Math.PI);
    // Проверяем по дорожному пути, если старт на изгибе улицы
    const firstNet = streetRoads.length > 0 ? findRoadNetworkPath(streetRoads, input.start, cp0) : null;
    let effectiveDiff = diffDeg;
    if (firstNet?.connected && firstNet.path.length >= 2) {
      const p0 = firstNet.path[0];
      const p1 = firstNet.path[1];
      if (Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.5) {
        const roadBearing = Math.atan2(p1.x - p0.x, p1.z - p0.z);
        effectiveDiff = Math.abs((angleDiffRad(input.start.h, roadBearing) * 180) / Math.PI);
      }
    }
    if (effectiveDiff > 115) {
      issues.push({
        severity: "warning",
        message: `На старте автомобиль развёрнут в сторону от КТ #1 (отклонение ${Math.round(effectiveDiff)}°).`,
        target: { kind: "start" },
      });
      canAutoFix = true;
    }
  }

  // 5. Пошаговая проверка всех КТ и участков маршрута (Старт → КТ #1 → ... → КТ #N)
  const fullSpine: Vec2[] = [{ x: input.start.x, z: input.start.z }];
  let totalLengthM = 0;
  let connectedLegsCount = 0;
  const seenIds = new Set<string>();

  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const num = i + 1;
    const from: Vec2 = i === 0 ? { x: input.start.x, z: input.start.z } : { x: cps[i - 1].x, z: cps[i - 1].z };
    const fromLabel = i === 0 ? "Старт" : `КТ #${i}`;
    const toLabel = `КТ #${num}`;

    if (seenIds.has(cp.id)) {
      issues.push({
        severity: "error",
        message: `Повторяющийся идентификатор контрольной точки «${cp.id}».`,
        target: { kind: "checkpoint", id: cp.id },
      });
      canAutoFix = true;
    }
    seenIds.add(cp.id);

    const cpInside = isInsideWorldBoundary(cp.x, cp.z, input.bounds, poly);
    if (!cpInside) {
      issues.push({
        severity: "error",
        message: hasPoly
          ? `${toLabel} находится снаружи произвольной границы маршрута.`
          : `${toLabel} находится за границами карты.`,
        target: { kind: "checkpoint", id: cp.id },
      });
      canAutoFix = true;
    }

    if (!(cp.radius >= 1 && cp.radius <= 18)) {
      issues.push({
        severity: "error",
        message: `${toLabel}: радиус срабатывания (${cp.radius} м) должен быть от 1 до 18 м.`,
        target: { kind: "checkpoint", id: cp.id },
      });
      canAutoFix = true;
    }

    if (i > 0) {
      const prev = cps[i - 1];
      const gap = Math.hypot(cp.x - prev.x, cp.z - prev.z);
      if (gap < Math.max(2, Math.min(cp.radius, prev.radius) * 0.5)) {
        issues.push({
          severity: "warning",
          message: `${toLabel} почти совпадает с КТ #${i} (расстояние ${gap.toFixed(1)} м).`,
          target: { kind: "checkpoint", id: cp.id },
        });
      }
    }

    if (cp.isFinalPark) {
      const validBays = freeBays.filter(
        (b) => isCarInsideBay(b.cx, b.cz, b.h, b) && !grid.queryCarHit(b.cx, b.cz, b.h).hit
      );
      if (freeBays.length === 0) {
        issues.push({
          severity: "warning",
          message: `${toLabel} отмечена как «финишная парковка», но свободных боксов на карте нет — добавьте бокс или снимите флажок.`,
          target: { kind: "checkpoint", id: cp.id },
        });
        canAutoFix = true;
      } else if (validBays.length === 0) {
        issues.push({
          severity: "warning",
          message: `${toLabel} требует парковку, но все свободные боксы перекрыты препятствиями или малы для кузова.`,
          target: { kind: "checkpoint", id: cp.id },
        });
      }
    }

    // Проверка привязки к дороге и связности участка
    const snapCp = streetRoads.length > 0 ? nearestRoadPoint(cp.x, cp.z, streetRoads) : null;
    if (snapCp && !cp.isFinalPark && input.useLotSurface === false) {
      const maxDistToRoad = snapCp.road.width / 2 + cp.radius + 1.5;
      if (snapCp.dist > maxDistToRoad) {
        issues.push({
          severity: "warning",
          message: `${toLabel} стоит в стороне от дороги (${snapCp.dist.toFixed(1)} м) — перетащите её на проезжую часть.`,
          target: { kind: "checkpoint", id: cp.id },
        });
      }
    }

    const approxH = snapCp ? snapCp.h : Math.atan2(cp.x - from.x, cp.z - from.z);
    const reach = isCheckpointReachable(cp, approxH, grid);
    if (!reach.ok) {
      issues.push({
        severity: "error",
        message: `${toLabel} полностью перекрыта препятствием «${reach.blocker?.label || reach.blocker?.id || "объект"}» — проезд невозможен.`,
        target: { kind: "checkpoint", id: cp.id },
      });
    }

    const net =
      streetRoads.length > 0
        ? findRoadNetworkPath(streetRoads, from, { x: cp.x, z: cp.z })
        : {
            connected: true,
            path: [from, { x: cp.x, z: cp.z }],
            lengthM: Number(Math.hypot(cp.x - from.x, cp.z - from.z).toFixed(1)),
            roadNames: [] as string[],
          };

    if (net.connected) connectedLegsCount += 1;
    totalLengthM += net.lengthM;

    const legBlocker = findLegBlocker(net.path, grid, snapCp?.road.width ?? 7);
    let legOutside = !cpInside;
    if (!legOutside && poly && net.path.length >= 2) {
      const mid = samplePolyline(net.path, net.lengthM * 0.5);
      if (!isInsideWorldBoundary(mid.x, mid.z, input.bounds, poly)) {
        legOutside = true;
        issues.push({
          severity: "warning",
          message: `Участок ${fromLabel} → ${toLabel} выходит за произвольную границу карты.`,
          target: { kind: "boundary" },
        });
        canAutoFix = true;
      }
    }

    if (streetRoads.length > 0 && !net.connected && input.useLotSurface === false && !cp.isFinalPark) {
      issues.push({
        severity: "warning",
        message: `Участок ${fromLabel} → ${toLabel} (${net.lengthM.toFixed(0)} м) не связан единой дорогой OSM (разрыв сети или точка вне улицы).`,
        target: { kind: "checkpoint", id: cp.id },
      });
    }

    if (legBlocker) {
      issues.push({
        severity: "warning",
        message: `На участке ${fromLabel} → ${toLabel} проезд перекрывает «${legBlocker.label || legBlocker.id}».`,
        target: { kind: "obstacle", id: legBlocker.id },
      });
    }

    const legStatus: RouteLegStatus = legOutside
      ? "outside"
      : legBlocker || !reach.ok
        ? "blocked"
        : net.connected
          ? "ok"
          : "offroad";

    legs.push({
      index: i,
      fromLabel,
      toLabel,
      checkpointId: cp.id,
      status: legStatus,
      connectedOnRoads: net.connected,
      lengthM: net.lengthM,
      roadNames: net.roadNames,
      blockedBy: legBlocker ? legBlocker.label || legBlocker.id : undefined,
      path: net.path,
    });

    for (const pt of net.path) {
      const prevPt = fullSpine[fullSpine.length - 1];
      if (!prevPt || Math.hypot(pt.x - prevPt.x, pt.z - prevPt.z) > 0.5) {
        fullSpine.push(pt);
      }
    }
    const lastPt = fullSpine[fullSpine.length - 1];
    if (!lastPt || Math.hypot(cp.x - lastPt.x, cp.z - lastPt.z) > 0.5) {
      fullSpine.push({ x: cp.x, z: cp.z });
    }
  }

  // 6. Считаем элементы дорожной обстановки вдоль маршрута (в коридоре ±16 м)
  const CORRIDOR_CHECK_M = 16;
  const signalsOnRoute =
    fullSpine.length >= 2
      ? (input.signals ?? []).filter(
          (sg) =>
            minDistToPolyline(sg.stopLineX, sg.stopLineZ, fullSpine) <= CORRIDOR_CHECK_M ||
            minDistToPolyline(sg.x, sg.z, fullSpine) <= CORRIDOR_CHECK_M
        ).length
      : 0;
  const crosswalksOnRoute =
    fullSpine.length >= 2
      ? (input.crosswalks ?? []).filter((cw) => minDistToPolyline(cw.cx, cw.cz, fullSpine) <= CORRIDOR_CHECK_M).length
      : 0;
  const signsOnRoute =
    fullSpine.length >= 2
      ? (input.signs ?? []).filter((sn) => minDistToPolyline(sn.x, sn.z, fullSpine) <= CORRIDOR_CHECK_M).length
      : 0;

  const roundedLen = Math.round(totalLengthM);
  // Средняя учебная скорость ~25 км/ч (≈ 7 м/с) + по 10 с на светофор/STOP
  const stopCount = cps.filter((c) => c.requireStop).length;
  const estimatedDurationSec = Math.max(10, Math.round(roundedLen / 7 + (signalsOnRoute + stopCount) * 10));

  const errCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;
  const status = errCount > 0 ? "errors" : warnCount > 0 ? "warnings" : "valid";

  const summary =
    status === "valid"
      ? `Маршрут исправен: ${cps.length} КТ · ${roundedLen} м (~${Math.max(1, Math.round(estimatedDurationSec / 60))} мин) · все участки проходимы.`
      : status === "warnings"
        ? `Маршрут проходим (${cps.length} КТ · ${roundedLen} м), замечаний: ${warnCount}.`
        : `Маршрут требует правки: ошибок ${errCount}${warnCount > 0 ? `, замечаний ${warnCount}` : ""}.`;

  return {
    ok: errCount === 0,
    status,
    summary,
    totalLengthM: roundedLen,
    estimatedDurationSec,
    checkpointsCount: cps.length,
    connectedLegsCount,
    freeBaysCount: freeBays.length,
    signalsOnRoute,
    crosswalksOnRoute,
    signsOnRoute,
    fullSpine,
    legs,
    issues,
    canAutoFix,
  };
}
