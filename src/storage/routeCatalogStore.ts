/**
 * @module storage/routeCatalogStore
 * @layer pure-core
 * @role Локальное хранилище каталога экзаменационных маршрутов; общие OSM-снимки хранятся отдельно от записей маршрутов.
 * @invariants #7 (без DOM/Three.js), #8 (данные локально, без сервера).
 */
import { isExamRouteRecord, type ExamRouteRecord } from "../maps/routeCatalog";
import type { CustomScenarioDef } from "../scenarios/custom";

const DB_NAME = "cdt-route-catalog";
const DB_VERSION = 2;
const ROUTES = "routes";
const MAPS = "maps";
let dbPromise: Promise<IDBDatabase> | null = null;
let memoryFallback = false;
const memory = new Map<string, ExamRouteRecord>();

type RouteSnapshotMeta = Pick<CustomScenarioDef,
  "version" | "title" | "subtitle" | "brief" | "start" | "defaultSpeedLimitKmh" |
  "lotHalfX" | "lotHalfZ" | "lotCenterX" | "lotCenterZ" | "useLotSurface" |
  "bays" | "checkpoints" | "perimeterCurb"
>;
type StoredRoute = Omit<ExamRouteRecord, "scenarioSnapshot"> & {
  /** Небольшие поля, которые отличаются между маршрутами одной карты. */
  snapshotMeta?: RouteSnapshotMeta;
  /** Только для чтения старых записей до/во время миграции v1 → v2. */
  scenarioSnapshot?: CustomScenarioDef;
};
type SharedMap = { fingerprint: string; scenarioSnapshot: CustomScenarioDef };

export type RouteCatalogLoad = {
  records: ExamRouteRecord[];
  backend: "indexeddb" | "memory";
  warning: string | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступна в этом браузере"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!db.objectStoreNames.contains(ROUTES)) {
        db.createObjectStore(ROUTES, { keyPath: "id" });
      }
      const maps = db.objectStoreNames.contains(MAPS)
        ? tx!.objectStore(MAPS)
        : db.createObjectStore(MAPS, { keyPath: "fingerprint" });

      // Миграция v1: каждый маршрут содержал полный OSM snapshot.
      // Переносим его в общий store и удаляем из записи маршрута атомарно
      // в рамках upgrade-транзакции IndexedDB.
      if (event.oldVersion < 2) {
        const cursorRequest = tx!.objectStore(ROUTES).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value as StoredRoute;
          if (value && typeof value.mapFingerprint === "string" && value.scenarioSnapshot) {
            maps.put({
              fingerprint: value.mapFingerprint,
              scenarioSnapshot: value.scenarioSnapshot,
            } satisfies SharedMap);
            const { scenarioSnapshot, ...compact } = value;
            compact.snapshotMeta = snapshotMeta(scenarioSnapshot);
            cursor.update(compact);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть каталог маршрутов"));
    request.onblocked = () => reject(new Error("Открытие каталога заблокировано другой вкладкой"));
  });
}

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Ошибка транзакции каталога"));
    tx.onabort = () => reject(tx.error ?? new Error("Транзакция каталога прервана"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Ошибка чтения каталога"));
  });
}

function sortRoutes(routes: ExamRouteRecord[]): ExamRouteRecord[] {
  return routes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, "ru"));
}

function snapshotMeta(snapshot: CustomScenarioDef): RouteSnapshotMeta {
  return {
    version: snapshot.version,
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    brief: snapshot.brief,
    start: { ...snapshot.start },
    defaultSpeedLimitKmh: snapshot.defaultSpeedLimitKmh,
    lotHalfX: snapshot.lotHalfX,
    lotHalfZ: snapshot.lotHalfZ,
    ...(snapshot.lotCenterX !== undefined ? { lotCenterX: snapshot.lotCenterX } : {}),
    ...(snapshot.lotCenterZ !== undefined ? { lotCenterZ: snapshot.lotCenterZ } : {}),
    ...(snapshot.useLotSurface !== undefined ? { useLotSurface: snapshot.useLotSurface } : {}),
    bays: snapshot.bays.map((bay) => ({ ...bay })),
    checkpoints: snapshot.checkpoints.map((point) => ({ ...point })),
    ...(snapshot.perimeterCurb !== undefined ? { perimeterCurb: snapshot.perimeterCurb } : {}),
  };
}

function compactRoute(record: ExamRouteRecord): StoredRoute {
  const { scenarioSnapshot, ...route } = record;
  return { ...route, snapshotMeta: snapshotMeta(scenarioSnapshot) };
}

export async function loadRouteCatalog(): Promise<RouteCatalogLoad> {
  try {
    const db = await getDb();
    const tx = db.transaction([ROUTES, MAPS], "readonly");
    const routeRequest = tx.objectStore(ROUTES).getAll();
    const mapRequest = tx.objectStore(MAPS).getAll();
    const [storedRoutes, maps] = await Promise.all([
      requestResult<StoredRoute[]>(routeRequest),
      requestResult<SharedMap[]>(mapRequest),
    ]);
    await transactionDone(tx);
    const snapshots = new Map(maps.map((map) => [map.fingerprint, map.scenarioSnapshot]));
    const records: ExamRouteRecord[] = [];
    for (const stored of storedRoutes) {
      const sharedSnapshot = snapshots.get(stored.mapFingerprint);
      const snapshot = stored.scenarioSnapshot ?? (sharedSnapshot && stored.snapshotMeta
        ? { ...sharedSnapshot, ...stored.snapshotMeta, mapMeta: stored.mapMeta }
        : sharedSnapshot);
      if (!snapshot) continue;
      const record = { ...stored, scenarioSnapshot: snapshot } as ExamRouteRecord;
      if (isExamRouteRecord(record)) records.push(record);
    }
    memory.clear();
    for (const record of records) memory.set(record.id, record);
    memoryFallback = false;
    return { records: sortRoutes(records), backend: "indexeddb", warning: null };
  } catch (error) {
    memoryFallback = true;
    return {
      records: sortRoutes([...memory.values()]),
      backend: "memory",
      warning: error instanceof Error ? error.message : "IndexedDB недоступна; каталог будет временным",
    };
  }
}

export async function saveRouteRecord(record: ExamRouteRecord): Promise<"indexeddb" | "memory"> {
  if (!isExamRouteRecord(record)) throw new Error("Запись маршрута не прошла проверку формата");
  if (memoryFallback) {
    memory.set(record.id, record);
    return "memory";
  }
  try {
    const db = await getDb();
    const tx = db.transaction([ROUTES, MAPS], "readwrite");
    tx.objectStore(MAPS).put({
      fingerprint: record.mapFingerprint,
      scenarioSnapshot: record.scenarioSnapshot,
    } satisfies SharedMap);
    tx.objectStore(ROUTES).put(compactRoute(record));
    await transactionDone(tx);
    memory.set(record.id, record);
    return "indexeddb";
  } catch {
    memoryFallback = true;
    memory.set(record.id, record);
    return "memory";
  }
}

export async function deleteRouteRecord(id: string): Promise<"indexeddb" | "memory"> {
  if (memoryFallback) {
    memory.delete(id);
    return "memory";
  }
  try {
    const db = await getDb();
    const tx = db.transaction([ROUTES, MAPS], "readwrite");
    const routes = tx.objectStore(ROUTES);
    const [target, allRoutes] = await Promise.all([
      requestResult<StoredRoute | undefined>(routes.get(id)),
      requestResult<StoredRoute[]>(routes.getAll()),
    ]);
    routes.delete(id);
    if (target && !allRoutes.some((route) => route.id !== id && route.mapFingerprint === target.mapFingerprint)) {
      tx.objectStore(MAPS).delete(target.mapFingerprint);
    }
    await transactionDone(tx);
    memory.delete(id);
    return "indexeddb";
  } catch {
    memoryFallback = true;
    memory.delete(id);
    return "memory";
  }
}
