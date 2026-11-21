import type { OfflineTrackMetadata } from "./radioCatalog";

/**
 * @module audio/trackStore
 * @layer three-render
 * @role Офлайн-кэш сохранённых радиотреков в IndexedDB (`cdt-audio`: `tracks` с WAV-блобами) с проверкой квоты и ограниченным fallback в память для небольших файлов.
 * @invariants #8 (локальное хранение без сервера), #13 (0 сетевых запросов для уже сохранённых треков).
 * @tests Смоук K7e (`tests/browser-smoke.mjs`); чистая логика каталога — T36
 */

const DB_NAME = "cdt-audio";
const DB_VERSION = 1;
const TRACKS = "tracks";
const MAX_MEMORY_FALLBACK_BYTES = 8 * 1024 * 1024;

/** Метаданные сохранённого трека (без самого аудио — оно в поле blob). */
export type SavedTrack = {
  key: string;
  stationId: string;
  stationName: string;
  freq: string;
  seconds: number;
  savedAt: string;
  size: number;
  metadata: OfflineTrackMetadata;
  blob: Blob;
};

export type TrackBackend = "indexeddb" | "memory";
export type TrackSaveResult = { backend: TrackBackend | "rejected"; reason?: string };

let backend: TrackBackend = "indexeddb";
let dbPromise: Promise<IDBDatabase> | null = null;
const memory = new Map<string, SavedTrack>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступна"));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть cdt-audio"));
    request.onblocked = () => reject(new Error("IndexedDB занята другой вкладкой"));
  });
}

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Ошибка запроса cdt-audio"));
  });
}

function normalizeMetadata(track: Partial<SavedTrack>): OfflineTrackMetadata {
  return track.metadata ?? {
    title: `${track.stationName ?? "Радио"} · сохранённый фрагмент`,
    artist: "Неизвестен",
    album: "Legacy radio cache",
    genre: "",
    tags: ["legacy-cache"],
    source: "synthetic",
  };
}

/** Текущий бэкенд кэша: IndexedDB или память (если браузер запретил хранилище). */
export function trackBackend(): TrackBackend {
  return backend;
}

/**
 * Сохраняет аудиофайл с метаданными в IndexedDB; в память вкладки переносит только небольшие файлы (до 8 МиБ).
 * @returns backend сохранения; крупные файлы не копируются в RAM при отказе IndexedDB.
 */
export async function saveTrack(
  track: Omit<SavedTrack, "savedAt" | "size">
): Promise<TrackSaveResult> {
  const entry: SavedTrack = {
    ...track,
    metadata: normalizeMetadata(track),
    savedAt: new Date().toISOString(),
    size: track.blob.size,
  };
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.quota === "number" && typeof estimate.usage === "number") {
        const available = Math.max(0, estimate.quota - estimate.usage);
        if (available < entry.size * 1.1) throw new Error("Недостаточно свободной квоты браузерного хранилища");
      }
    }
    const db = await getDb();
    const tx = db.transaction(TRACKS, "readwrite");
    tx.objectStore(TRACKS).put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Ошибка записи cdt-audio"));
      tx.onabort = () => reject(tx.error ?? new Error("Запись cdt-audio прервана"));
    });
    backend = "indexeddb";
    return { backend: "indexeddb" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Браузер не разрешил сохранить аудио";
    if (entry.size <= MAX_MEMORY_FALLBACK_BYTES) {
      backend = "memory";
      memory.set(entry.key, entry);
      return { backend: "memory", reason };
    }
    backend = "memory";
    return { backend: "rejected", reason: `${reason}. Большой файл не помещён в память вкладки.` };
  }
}

/** Список сохранённых треков без аудиоданных (для UI): новые сверху. */
export async function listTracks(): Promise<Array<Omit<SavedTrack, "blob">>> {
  const strip = (t: SavedTrack): Omit<SavedTrack, "blob"> => ({
    key: t.key,
    stationId: t.stationId,
    stationName: t.stationName,
    freq: t.freq,
    seconds: t.seconds,
    savedAt: t.savedAt,
    size: t.size,
    metadata: normalizeMetadata(t),
  });
  try {
    const db = await getDb();
    const all = (await done(db.transaction(TRACKS, "readonly").objectStore(TRACKS).getAll())) as SavedTrack[];
    return all.map(strip).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } catch {
    backend = "memory";
    return [...memory.values()].map(strip).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }
}

/** Читает сохранённый трек вместе с аудио (или `null`, если его нет в кэше). */
export async function loadTrack(key: string): Promise<SavedTrack | null> {
  try {
    const db = await getDb();
    const hit = (await done(
      db.transaction(TRACKS, "readonly").objectStore(TRACKS).get(key)
    )) as SavedTrack | undefined;
    return hit ? { ...hit, metadata: normalizeMetadata(hit) } : null;
  } catch {
    backend = "memory";
    return memory.get(key) ?? null;
  }
}

/** Удаляет трек из кэша по ключу. */
export async function deleteTrack(key: string): Promise<void> {
  memory.delete(key);
  try {
    const db = await getDb();
    const tx = db.transaction(TRACKS, "readwrite");
    tx.objectStore(TRACKS).delete(key);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    backend = "memory";
  }
}

/** Полностью очищает кэш треков (кнопка «Очистить кэш» в настройках ШГУ). */
export async function clearTracks(): Promise<void> {
  memory.clear();
  try {
    const db = await getDb();
    const tx = db.transaction(TRACKS, "readwrite");
    tx.objectStore(TRACKS).clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    backend = "memory";
  }
}
