/**
 * @module storage/routeCatalogStore
 * @layer pure-core
 * @role Локальное хранилище каталога экзаменационных маршрутов в отдельной IndexedDB; при недоступности — временный fallback в памяти.
 * @invariants #7 (без DOM/Three.js), #8 (данные локально, без сервера).
 */
import { isExamRouteRecord, type ExamRouteRecord } from "../maps/routeCatalog";

const DB_NAME = "cdt-route-catalog";
const DB_VERSION = 1;
const STORE = "routes";
let dbPromise: Promise<IDBDatabase> | null = null;
let memoryFallback = false;
const memory = new Map<string, ExamRouteRecord>();

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
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
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

function sortRoutes(routes: ExamRouteRecord[]): ExamRouteRecord[] {
  return routes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, "ru"));
}

export async function loadRouteCatalog(): Promise<RouteCatalogLoad> {
  try {
    const db = await getDb();
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    const records = await new Promise<ExamRouteRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as unknown[]).filter(isExamRouteRecord));
      request.onerror = () => reject(request.error ?? new Error("Не удалось прочитать каталог"));
    });
    await transactionDone(tx);
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
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
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
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await transactionDone(tx);
    memory.delete(id);
    return "indexeddb";
  } catch {
    memoryFallback = true;
    memory.delete(id);
    return "memory";
  }
}
