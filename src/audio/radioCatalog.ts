/**
 * @module audio/radioCatalog
 * @layer pure-core
 * @role Каталог прямых интернет-радиопотоков и независимых процедурных офлайн-сессий в WAV; синтез не является записью живого эфира.
 * @invariants #7 (без DOM, `window`, `document` и Three.js — чистые функции и типизированные массивы), #8 (полный офлайн-фолбэк без внешних ассетов).
 * @tests T36 (src/sim/selfTestExtra.ts)
 */

/** Станция встроенного тюнера ШГУ: реальный интернет-поток + параметры независимого процедурного офлайн-синтеза. */
export type RadioStation = {
  id: string;
  freq: string;
  name: string;
  genre: string;
  /** Прямая ссылка на интернет-поток (MP3/AAC). Воспроизводится элементом `<audio>` без CORS-ограничений. */
  streamUrl: string;
  accent: string;
  bpm: number;
  /** Аккордовая сетка процедурного синтеза (частоты в Гц); не описывает фактическое содержимое интернет-потока. */
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
/** Минимальная целевая длительность сохранённой офлайн-сессии радио — 10 минут. */
export const OFFLINE_TRACK_SECONDS = 600;

export type OfflineTrackMetadata = {
  title: string;
  artist: string;
  album: string;
  genre: string;
  tags: string[];
  source: "synthetic";
};

export function stationTrackMetadata(station: RadioStation): OfflineTrackMetadata {
  return {
    title: `${station.name} · офлайн-сессия`,
    artist: "DrivingSim Radio Generator",
    album: "DrivingSim Offline Radio",
    genre: station.genre,
    tags: ["offline", "synthesized", "radio", station.id],
    source: "synthetic",
  };
}

/** Значение громкости по умолчанию (0..1) и шаг изменения шайбой VOL. */
export const DEFAULT_VOLUME = 0.7;
export const VOLUME_STEP = 0.1;

/** Переход к следующей (`+1`) или предыдущей (`−1`) станции по кругу. */
export function nextStationIndex(current: number, dir: 1 | -1, stations: readonly RadioStation[] = INTERNET_RADIO_STATIONS): number {
  const total = stations.length;
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

/** WAV LIST/INFO: стандартные поля названия, исполнителя, альбома, жанра и комментария. */
function wavInfoChunk(metadata: OfflineTrackMetadata): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries: Array<[string, string]> = [
    ["INAM", metadata.title],
    ["IART", metadata.artist],
    ["IPRD", metadata.album],
    ["IGNR", metadata.genre],
    ["ICMT", `Источник: ${metadata.source}; теги: ${metadata.tags.join(", ")}; синтезированный звук, не запись интернет-эфира.`],
  ];
  const chunks = entries.map(([id, value]) => {
    const text = encoder.encode(value + "\0");
    const paddedLength = text.length + (text.length % 2);
    const chunk = new Uint8Array(new ArrayBuffer(8 + paddedLength));
    const view = new DataView(chunk.buffer);
    writeAscii(view, 0, id);
    view.setUint32(4, text.length, true);
    chunk.set(text, 8);
    return chunk;
  });
  const bodyLength = 4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(new ArrayBuffer(8 + bodyLength));
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "LIST");
  view.setUint32(4, bodyLength, true);
  writeAscii(view, 8, "INFO");
  let offset = 12;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/**
 * Синтезирует автономную офлайн-сессию станции в WAV (моно, PCM 16 бит, 22 050 Гц).
 * Это процедурная музыка по параметрам станции, а не запись или копия её живого эфира.
 * WAV содержит LIST/INFO-метаданные: название, исполнитель, альбом, жанр и комментарии с тегами.
 */
export function renderTrackWav(
  station: RadioStation,
  seconds = OFFLINE_TRACK_SECONDS,
  metadata: OfflineTrackMetadata = stationTrackMetadata(station)
): Uint8Array<ArrayBuffer> {
  const dur = Math.min(OFFLINE_TRACK_SECONDS, Math.max(1, Math.round(seconds)));
  const sr = TRACK_SAMPLE_RATE;
  const frames = sr * dur;
  const pcmBytes = frames * 2;
  const info = wavInfoChunk(metadata);
  const out = new Uint8Array(new ArrayBuffer(44 + pcmBytes + info.length));
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmBytes, true);
  const stepSec = 60 / Math.max(40, station.bpm) / 2;
  const stepLen = Math.max(1, Math.round(stepSec * sr));
  const bassLen = Math.max(1, Math.round(stepSec * 2 * sr));
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const step = Math.floor(i / stepLen) % station.notes.length;
    const tInStep = (i % stepLen) / sr;
    const tInBass = (i % bassLen) / sr;
    const noteFreq = station.notes[step];
    const env = Math.exp(-tInStep * 6.5);
    const lead = Math.sin(2 * Math.PI * noteFreq * t) * 0.32 * env;
    const harm = Math.sin(2 * Math.PI * noteFreq * 2 * t) * 0.08 * env;
    const bassEnv = Math.exp(-tInBass * 1.6);
    const bass = Math.sin(2 * Math.PI * station.bass * t) * 0.26 * bassEnv;
    const beatSec = 60 / Math.max(40, station.bpm);
    const inBeat = (t % beatSec) / beatSec;
    const kick = inBeat < 0.16 ? Math.sin(2 * Math.PI * 62 * t) * Math.exp(-inBeat * 30) * 0.32 : 0;
    const hatEnv = inBeat > 0.5 && inBeat < 0.585 ? Math.exp(-(inBeat - 0.5) * 42) * 0.05 : 0;
    const hat = hatEnv * (Math.sin(2 * Math.PI * 4100 * t) + Math.sin(2 * Math.PI * 6700 * t)) * 0.5;
    const fade = Math.min(1, t / 0.4, (dur - t) / 0.6);
    const sample = Math.max(-1, Math.min(1, (lead + harm + bass + kick + hat) * Math.max(0, fade)));
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  out.set(info, 44 + pcmBytes);
  return out;
}
/** Короткое описание трека для списка кэша и подсказок ШГУ. */
export function describeStation(station: RadioStation): string {
  return `${station.freq} · ${station.name} · ${station.genre}`;
}
