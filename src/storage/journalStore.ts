/**
 * @module storage/journalStore
 * @layer pure-core
 * @role Хранилище журнала попыток в IndexedDB (`cdt-journal`: `meta` + `payload`), миграция `localStorage` и fallback в память.
 * @invariants #7 (без обращений к DOM и Three.js), #8 (локальное хранение), #15 (одна попытка — одна запись).
 * @tests Смоук B, D, H (`tests/browser-smoke.mjs`); чистая логика — T19
 */
import { byNewest, joinAttempt, splitAttempt, type AttemptMeta, type AttemptPayload } from "../sim/journal";
import type { RecordedAttempt } from "../sim/recorder";

/**
 * Хранилище журнала попыток в IndexedDB.
 * Два хранилища объектов: meta (лёгкая часть, читается целиком при старте) и
 * payload (траектория, ввод, снимки мира и правил — читается по одной попытке).
 *
 * Если IndexedDB недоступна, журнал работает в памяти до закрытия вкладки,
 * и приложение сообщает об этом пользователю — ошибки не скрываются.
 */

const DB_NAME = "cdt-journal";
const DB_VERSION = 1;
const META = "meta";
const PAYLOAD = "payload";
/** Журнал прежней версии (до 20 попыток в localStorage) — переносится при первом запуске. */
const LEGACY_KEY = "cdt.attempts.journal.v1";

export type JournalBackend = "indexeddb" | "memory";
export type JournalInit = { backend: JournalBackend; migrated: number; error: string | null };

let backend: JournalBackend = "indexeddb";
let dbPromise: Promise<IDBDatabase> | null = null;
const memory = new Map<string, RecordedAttempt>();

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object" && "name" in err) return String((err as { name: unknown }).name);
  return "неизвестная ошибка";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступна в этом браузере"));
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
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAYLOAD)) db.createObjectStore(PAYLOAD, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB заблокирована другой вкладкой"));
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

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Ошибка запроса IndexedDB"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Ошибка транзакции IndexedDB"));
    tx.onabort = () => reject(tx.error ?? new Error("Транзакция IndexedDB прервана"));
  });
}

function isAttemptLike(value: unknown): value is RecordedAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.createdAt === "string" &&
    Array.isArray(a.events) &&
    Array.isArray(a.trajectory) &&
    Array.isArray(a.inputStream) &&
    Boolean(a.evaluation) &&
    typeof a.evaluation === "object"
  );
}

function readLegacyJournal(): RecordedAttempt[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAttemptLike) : [];
  } catch {
    return [];
  }
}

/**
 * Открывает хранилище и переносит журнал прежней версии.
 * Старый ключ удаляется только после успешной записи в IndexedDB.
 * Не бросает исключений: при сбое включается режим «в памяти».
 */
export async function initJournalStore(): Promise<JournalInit> {
  const legacy = readLegacyJournal();
  try {
    const db = await getDb();
    if (legacy.length > 0) {
      const tx = db.transaction([META, PAYLOAD], "readwrite");
      const metaStore = tx.objectStore(META);
      const payloadStore = tx.objectStore(PAYLOAD);
      for (const attempt of legacy) {
        const { meta, payload } = splitAttempt(attempt);
        metaStore.put(meta);
        payloadStore.put(payload);
      }
      await transactionDone(tx);
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // ключ останется и будет перенесён повторно — запись по id идемпотентна
      }
    }
    backend = "indexeddb";
    return { backend, migrated: legacy.length, error: null };
  } catch (err) {
    backend = "memory";
    memory.clear();
    for (const attempt of legacy) memory.set(attempt.id, attempt);
    return { backend, migrated: 0, error: errorText(err) };
  }
}

export function getJournalBackend(): JournalBackend {
  return backend;
}

export async function loadJournalMeta(): Promise<AttemptMeta[]> {
  if (backend === "memory") {
    return [...memory.values()].map((a) => splitAttempt(a).meta).sort(byNewest);
  }
  const db = await getDb();
  const tx = db.transaction(META, "readonly");
  const all = await requestDone<AttemptMeta[]>(tx.objectStore(META).getAll());
  return all.sort(byNewest);
}

export async function loadAttempts(ids: readonly string[]): Promise<RecordedAttempt[]> {
  if (ids.length === 0) return [];
  if (backend === "memory") {
    return ids.map((id) => memory.get(id)).filter((a): a is RecordedAttempt => Boolean(a));
  }
  const db = await getDb();
  const tx = db.transaction([META, PAYLOAD], "readonly");
  const metaStore = tx.objectStore(META);
  const payloadStore = tx.objectStore(PAYLOAD);
  // Все запросы ставятся в очередь синхронно — транзакция не закрывается раньше времени
  const pairs = await Promise.all(
    ids.map(async (id) => {
      const [meta, payload] = await Promise.all([
        requestDone<AttemptMeta | undefined>(metaStore.get(id)),
        requestDone<AttemptPayload | undefined>(payloadStore.get(id)),
      ]);
      return meta ? joinAttempt(meta, payload) : null;
    })
  );
  return pairs.filter((a): a is RecordedAttempt => a !== null);
}

export async function loadAttempt(id: string): Promise<RecordedAttempt | null> {
  const found = await loadAttempts([id]);
  return found[0] ?? null;
}

/** Сохраняет попытку целиком и в той же транзакции удаляет вытесненные лимитом журнала. */
export async function saveAttempt(attempt: RecordedAttempt, evictIds: readonly string[] = []): Promise<void> {
  if (backend === "memory") {
    memory.set(attempt.id, attempt);
    for (const id of evictIds) memory.delete(id);
    return;
  }
  const db = await getDb();
  const tx = db.transaction([META, PAYLOAD], "readwrite");
  const metaStore = tx.objectStore(META);
  const payloadStore = tx.objectStore(PAYLOAD);
  const { meta, payload } = splitAttempt(attempt);
  metaStore.put(meta);
  payloadStore.put(payload);
  for (const id of evictIds) {
    metaStore.delete(id);
    payloadStore.delete(id);
  }
  await transactionDone(tx);
}

/** Обновляет только лёгкую часть (ученик, оценки инструкторов) — запись заезда не трогается. */
export async function saveMeta(meta: AttemptMeta): Promise<void> {
  if (backend === "memory") {
    const existing = memory.get(meta.id);
    memory.set(meta.id, joinAttempt(meta, existing ? splitAttempt(existing).payload : null));
    return;
  }
  const db = await getDb();
  const tx = db.transaction(META, "readwrite");
  tx.objectStore(META).put(meta);
  await transactionDone(tx);
}

export async function clearJournalStore(): Promise<void> {
  memory.clear();
  if (backend === "memory") return;
  const db = await getDb();
  const tx = db.transaction([META, PAYLOAD], "readwrite");
  tx.objectStore(META).clear();
  tx.objectStore(PAYLOAD).clear();
  await transactionDone(tx);
}
