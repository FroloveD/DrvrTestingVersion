/**
 * @module sim/journal
 * @layer pure-core
 * @role Разделение попытки на лёгкую (`AttemptMeta`) и тяжёлую (`AttemptPayload`) части, лимит 300 записей и ревью инструкторов.
 * @invariants #7 (чистое ядро), #15 (одна попытка — один `id`; вытеснение сначала записей без оценки инструктора).
 * @tests T19
 */
import type { InstructorReview, RecordedAttempt } from "./recorder";

/**
 * Журнал попыток: чистая логика без хранилища.
 * Попытка делится на лёгкую часть (нужна списку, статистике и сверке) и тяжёлую
 * (траектория и поток ввода — нужны только реплею и экспорту), чтобы журнал на сотни
 * попыток не держал в памяти десятки мегабайт.
 */

type HeavyKey = "trajectory" | "inputStream" | "customWorld" | "rulesAtRide";

export type AttemptMeta = Omit<RecordedAttempt, HeavyKey>;
export type AttemptPayload = Pick<RecordedAttempt, "id" | HeavyKey>;

export const JOURNAL_LIMIT = 300;

export function byNewest(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

export function splitAttempt(attempt: RecordedAttempt): { meta: AttemptMeta; payload: AttemptPayload } {
  const { trajectory, inputStream, customWorld, rulesAtRide, ...meta } = attempt;
  const payload: AttemptPayload = { id: attempt.id, trajectory, inputStream };
  if (customWorld) payload.customWorld = customWorld;
  if (rulesAtRide) payload.rulesAtRide = rulesAtRide;
  return { meta, payload };
}

export function joinAttempt(meta: AttemptMeta, payload: AttemptPayload | null | undefined): RecordedAttempt {
  const full: RecordedAttempt = {
    ...meta,
    trajectory: payload?.trajectory ?? [],
    inputStream: payload?.inputStream ?? [],
  };
  if (payload?.customWorld) full.customWorld = payload.customWorld;
  if (payload?.rulesAtRide) full.rulesAtRide = payload.rulesAtRide;
  return full;
}

function hasReviews(a: AttemptMeta): boolean {
  return Array.isArray(a.reviews) && a.reviews.length > 0;
}

/**
 * Добавляет или обновляет попытку (по id) и применяет лимит журнала.
 * При переполнении сначала уходят самые старые попытки без оценки инструктора:
 * оценённые заезды — эталонная выборка, их потеря обесценивает сверку.
 */
export function upsertJournal(
  list: readonly AttemptMeta[],
  incoming: AttemptMeta,
  limit: number = JOURNAL_LIMIT
): { list: AttemptMeta[]; evictedIds: string[] } {
  const existing = list.find((a) => a.id === incoming.id);
  const merged: AttemptMeta = existing
    ? {
        ...incoming,
        student: incoming.student ?? existing.student,
        reviews: incoming.reviews ?? existing.reviews,
        closed: Boolean(incoming.closed) || Boolean(existing.closed),
      }
    : incoming;

  const next = [merged, ...list.filter((a) => a.id !== incoming.id)].sort(byNewest);
  const evictedIds: string[] = [];

  while (next.length > Math.max(1, limit)) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].id !== merged.id && !hasReviews(next[i])) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].id !== merged.id) {
          index = i;
          break;
        }
      }
    }
    if (index === -1) break;
    evictedIds.push(next[index].id);
    next.splice(index, 1);
  }
  return { list: next, evictedIds };
}

/** Имя инструктора сравнивается без учёта регистра и лишних пробелов. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

export function findReview(
  attempt: { reviews?: InstructorReview[] },
  instructor: string
): InstructorReview | undefined {
  const key = normalizeName(instructor);
  if (!key) return undefined;
  return attempt.reviews?.find((r) => normalizeName(r.instructor) === key);
}

/** Один инструктор — одна оценка на попытку: повторная заменяет прежнюю. */
export function upsertReview<T extends { reviews?: InstructorReview[] }>(attempt: T, review: InstructorReview): T {
  const key = normalizeName(review.instructor);
  const others = (attempt.reviews ?? []).filter((r) => normalizeName(r.instructor) !== key);
  const cleaned: InstructorReview = { ...review, instructor: review.instructor.trim().replace(/\s+/g, " ") };
  return { ...attempt, reviews: [...others, cleaned] };
}

export function removeReview<T extends { reviews?: InstructorReview[] }>(attempt: T, instructor: string): T {
  const key = normalizeName(instructor);
  const rest = (attempt.reviews ?? []).filter((r) => normalizeName(r.instructor) !== key);
  return { ...attempt, reviews: rest.length > 0 ? rest : undefined };
}
