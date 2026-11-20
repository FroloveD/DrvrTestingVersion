/**
 * @module audio/radioCatalog
 * @layer pure-core
 * @role Каталог реальных интернет-радиостанций (прямые MP3/AAC-потоки) и офлайн-синтез тех же эфиров в WAV для кэша сохранённых треков.
 * @invariants #7 (без DOM, `window`, `document` и Three.js — чистые функции и типизированные массивы), #8 (полный офлайн-фолбэк без внешних ассетов).
 * @tests T36 (src/sim/selfTestExtra.ts)
 */

/** Станция встроенного тюнера ШГУ: реальный интернет-поток + параметры офлайн-синтеза того же эфира. */
export type RadioStation = {
  id: string;
  freq: string;
  name: string;
  genre: string;
  /** Прямая ссылка на интернет-поток (MP3/AAC). Воспроизводится элементом `<audio>` без CORS-ограничений. */
  streamUrl: string;
  accent: string;
  bpm: number;
  /** Аккордовая сетка эфира (частоты в Гц) для офлайн-синтеза и кэширования трека. */
  notes: readonly number[];
  /** Базовая частота басовой линии. */
  bass: number;
  /** Включена ли станция в список тюнера сценария (редактор списка подключаемых станций). */
  enabled?: boolean;
};

/**
 * Станции, включённые в сценарий (редактор списка): порядок каталога сохраняется,
 * пустой/неизвестный список даёт весь каталог — старые сценарии не меняют поведения.
 */
export function enabledRadioStations(all: readonly RadioStation[] = INTERNET_RADIO_STATIONS): RadioStation[] {
  const on = all.filter((st) => st.enabled !== false);
  return on.length > 0 ? on : [...all];
}

/**
 * Список станций для конкретного сценария: берём `radioStationIds` из сценария,
 * неизвестные id отбрасываем, пустой результат — все станции каталога.
 */
export function radioStationsFor(
  ids: readonly string[] | undefined,
  all: readonly RadioStation[] = INTERNET_RADIO_STATIONS
): RadioStation[] {
  const active = enabledRadioStations(all);
  if (!ids || ids.length === 0) return active;
  const wanted = new Set(ids);
  const picked = active.filter((st) => wanted.has(st.id));
  return picked.length > 0 ? picked : active;
}

export const INTERNET_RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: "record",
    freq: "96.0",
    name: "RECORD",
    genre: "Dance / Pop",
    streamUrl: "https://radiorecord.hostingradio.ru/rr_main96.aacp",
    accent: "#52d6bd",
    bpm: 124,
    notes: [261.63, 329.63, 392, 523.25, 392, 329.63, 293.66, 440],
    bass: 65.41,
  },
  {
    id: "europa-plus",
    freq: "100.5",
    name: "EUROPA PLUS",
    genre: "Hit Radio",
    streamUrl: "https://ep128.hostingradio.ru:8030/ep128",
    accent: "#f5b942",
    bpm: 118,
    notes: [246.94, 311.13, 369.99, 493.88, 440, 369.99, 311.13, 277.18],
    bass: 61.74,
  },
  {
    id: "record-deep",
    freq: "101.2",
    name: "RECORD DEEP",
    genre: "Deep House",
    streamUrl: "https://radiorecord.hostingradio.ru/deep96.aacp",
    accent: "#a78bfa",
    bpm: 122,
    notes: [220, 277.18, 329.63, 415.3, 329.63, 277.18, 246.94, 369.99],
    bass: 55,
  },
  {
    id: "groove-salad",
    freq: "104.7",
    name: "GROOVE SALAD",
    genre: "Ambient / Downtempo",
    streamUrl: "https://ice2.somafm.com/groovesalad-128-mp3",
    accent: "#38bdf8",
    bpm: 92,
    notes: [196, 246.94, 293.66, 392, 349.23, 293.66, 261.63, 329.63],
    bass: 49,
  },
  {
    id: "drone-zone",
    freq: "106.2",
    name: "DRONE ZONE",
    genre: "Ambient",
    streamUrl: "https://ice2.somafm.com/dronezone-128-mp3",
    accent: "#94a3b8",
    bpm: 70,
    notes: [174.61, 220, 261.63, 349.23, 329.63, 261.63, 233.08, 293.66],
    bass: 43.65,
  },
  {
    id: "radio-paradise",
    freq: "95.6",
    name: "RADIO PARADISE",
    genre: "Eclectic Rock",
    streamUrl: "https://stream.radioparadise.com/aac-128",
    accent: "#ff8a8a",
    bpm: 104,
    notes: [220, 261.63, 329.63, 440, 392, 329.63, 293.66, 349.23],
    bass: 55,
  },
];

/** Частота дискретизации офлайн-синтеза треков (моно PCM 16 бит, WAV). */
export const TRACK_SAMPLE_RATE = 22050;

/** Значение громкости по умолчанию (0..1) и шаг изменения шайбой VOL. */
export const DEFAULT_VOLUME = 0.7;
export const VOLUME_STEP = 0.1;

/** Переход к следующей (`+1`) или предыдущей (`−1`) станции по кругу. */
export function nextStationIndex(current: number, dir: 1 | -1): number {
  const total = INTERNET_RADIO_STATIONS.length;
  if (total === 0) return 0;
  return ((Math.round(current) + dir) % total + total) % total;
}

/** Ограничение громкости диапазоном `0..1` с шагом 0.01. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

/** Ключ трека в кэше IndexedDB: станция + длительность (вариант рендера). */
export function trackCacheKey(stationId: string, seconds: number): string {
  return `radio:${stationId}:${Math.max(1, Math.round(seconds))}s`;
}

/** Человекочитаемая длительность `мм:сс` для списка сохранённых треков. */
export function formatTrackDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Синтезирует офлайн-версию эфира станции в WAV (моно, PCM 16 бит, 22 050 Гц).
 *
 * Трек строится детерминированно (без случайности и без DOM): арпеджио по аккордовой сетке
 * `station.notes`, басовая линия `station.bass` и мягкая перкуссия по `station.bpm`.
 * Такой WAV кэшируется в IndexedDB и играет офлайн — в том числе сохранённый «во время поездки».
 *
 * @param station Станция каталога.
 * @param seconds Длительность трека в секундах (`1..120`).
 * @returns Готовый WAV-файл (`Uint8Array` с заголовком RIFF/WAVE).
 */
export function renderTrackWav(station: RadioStation, seconds = 24): Uint8Array<ArrayBuffer> {
  const dur = Math.min(120, Math.max(1, Math.round(seconds)));
  const sr = TRACK_SAMPLE_RATE;
  const frames = sr * dur;
  const out = new Uint8Array(new ArrayBuffer(44 + frames * 2));
  const view = new DataView(out.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // размер fmt-блока
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // моно
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true); // байт/с
  view.setUint16(32, 2, true); // выравнивание блока
  view.setUint16(34, 16, true); // бит на сэмпл
  writeAscii(view, 36, "data");
  view.setUint32(40, frames * 2, true);

  const stepSec = 60 / Math.max(40, station.bpm) / 2; // шаг арпеджио (восьмые)
  const stepLen = Math.max(1, Math.round(stepSec * sr));
  const bassLen = Math.max(1, Math.round(stepSec * 2 * sr));

  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const step = Math.floor(i / stepLen) % station.notes.length;
    const tInStep = (i % stepLen) / sr;
    const tInBass = (i % bassLen) / sr;

    // Арпеджио: затухающий треугольник с мягкой атакой
    const noteFreq = station.notes[step];
    const env = Math.exp(-tInStep * 6.5);
    const lead = Math.sin(2 * Math.PI * noteFreq * t) * 0.32 * env;
    const harm = Math.sin(2 * Math.PI * noteFreq * 2 * t) * 0.08 * env;

    // Бас: синус с октавным удвоением, сглаженная огибающая
    const bassEnv = Math.exp(-tInBass * 1.6);
    const bass = Math.sin(2 * Math.PI * station.bass * t) * 0.26 * bassEnv;

    // Перкуссия: короткий «кик» на каждой четверти и «хай-хэт» на восьмых
    const beatSec = 60 / Math.max(40, station.bpm);
    const inBeat = (t % beatSec) / beatSec;
    const kick = inBeat < 0.16 ? Math.sin(2 * Math.PI * 62 * t) * Math.exp(-inBeat * 30) * 0.32 : 0;
    // «Хай-хэт» — короткий детерминированный всплеск шума-подобной суммы нечётных гармоник
    const hatEnv = inBeat > 0.5 && inBeat < 0.585 ? Math.exp(-(inBeat - 0.5) * 42) * 0.05 : 0;
    const hat = hatEnv * (Math.sin(2 * Math.PI * 4100 * t) + Math.sin(2 * Math.PI * 6700 * t)) * 0.5;

    // Плавный фейд по краям, чтобы кэш-трек звучал законченно
    const fade = Math.min(1, t / 0.4, (dur - t) / 0.6);
    const sample = Math.max(-1, Math.min(1, (lead + harm + bass + kick + hat) * Math.max(0, fade)));
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return out;
}

/** Короткое описание трека для списка кэша и подсказок ШГУ. */
export function describeStation(station: RadioStation): string {
  return `${station.freq} · ${station.name} · ${station.genre}`;
}
