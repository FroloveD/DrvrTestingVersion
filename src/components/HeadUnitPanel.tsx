/**
 * @module components/HeadUnitPanel
 * @layer ui
 * @role Управление мультимедийным блоком салона: режимы, интернет-радио, громкость и офлайн-кэш треков.
 * @invariants Воспроизведение начинается только после действия пользователя; сохранённые треки читаются из локального IndexedDB.
 */
import { useEffect, useRef, useState } from "react";
import {
  clampVolume,
  formatTrackDuration,
  INTERNET_RADIO_STATIONS,
  renderTrackWav,
  trackCacheKey,
  type RadioStation,
} from "../audio/radioCatalog";
import * as trackStore from "../audio/trackStore";
import { HEAD_UNIT_MODES, type HeadUnitState } from "../render/cockpitDisplays";

type TrackMeta = Awaited<ReturnType<typeof trackStore.listTracks>>[number];

export function HeadUnitPanel({ value, onChange, stations = INTERNET_RADIO_STATIONS, soundEnabled, soundLayers, onSoundEnabledChange, onSoundLayerToggle }: { value: HeadUnitState; onChange: (next: HeadUnitState) => void; stations?: readonly RadioStation[]; soundEnabled: boolean; soundLayers: { engine: boolean; horn: boolean; indicator: boolean }; onSoundEnabledChange: (enabled: boolean) => void; onSoundLayerToggle: (layer: "engine" | "horn" | "indicator") => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [tracks, setTracks] = useState<TrackMeta[]>([]);
  const [message, setMessage] = useState("");

  const stationIndex = stations.length ? ((value.stationIndex % stations.length) + stations.length) % stations.length : 0;
  const station = stations[stationIndex] ?? INTERNET_RADIO_STATIONS[0];
  const stepStation = (dir: 1 | -1) => stations.length ? (stationIndex + dir + stations.length) % stations.length : 0;


  useEffect(() => {
    void trackStore.listTracks().then(setTracks).catch(() => setTracks([]));
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = clampVolume(value.volume);
    if (value.mode !== "radio" || !value.radioPlaying) {
      audio.pause();
      return;
    }

    let cancelled = false;
    const start = async () => {
      try {
        let src = station.streamUrl;
        if (value.source === "saved" && value.savedTrackKey) {
          const saved = await trackStore.loadTrack(value.savedTrackKey);
          if (!saved) throw new Error("Сохранённый трек не найден.");
          if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = URL.createObjectURL(saved.blob);
          src = objectUrlRef.current;
        }
        if (cancelled) return;
        if (audio.src !== src) audio.src = src;
        await audio.play();
        if (!cancelled) onChange({ ...value, streamStatus: "live" });
      } catch {
        if (!cancelled) {
          onChange({ ...value, streamStatus: "error", radioPlaying: false });
          setMessage(value.source === "stream" ? "Поток недоступен или браузер запретил воспроизведение." : "Не удалось открыть сохранённый трек.");
        }
      }
    };
    onChange({ ...value, streamStatus: "connecting" });
    void start();
    return () => {
      cancelled = true;
      audio.pause();
    };
  }, [value.mode, value.radioPlaying, value.stationIndex, value.source, value.savedTrackKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = clampVolume(value.volume);
  }, [value.volume]);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const chooseMode = (mode: HeadUnitState["mode"]) => {
    onChange({ ...value, mode, radioPlaying: mode === "radio" ? value.radioPlaying : false, streamStatus: "idle" });
  };

  const saveOffline = async () => {
    try {
      const seconds = 24;
      const bytes = renderTrackWav(station, seconds);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const key = trackCacheKey(station.id, seconds);
      await trackStore.saveTrack({ key, stationId: station.id, stationName: station.name, freq: station.freq, seconds, blob });
      const list = await trackStore.listTracks();
      setTracks(list);
      onChange({ ...value, savedCount: list.length });
      setMessage(trackStore.trackBackend() === "indexeddb" ? "Трек сохранён офлайн." : "Трек доступен до закрытия вкладки (IndexedDB недоступна).");
    } catch {
      setMessage("Не удалось сохранить трек.");
    }
  };

  const playSaved = (track: TrackMeta) => {
    onChange({ ...value, mode: "radio", radioPlaying: true, source: "saved", savedTrackKey: track.key, streamStatus: "connecting" });
  };

  const deleteSaved = async (key: string) => {
    await trackStore.deleteTrack(key);
    const list = await trackStore.listTracks();
    setTracks(list);
    if (value.savedTrackKey === key) onChange({ ...value, radioPlaying: false, savedTrackKey: null, source: "stream", savedCount: list.length });
    else onChange({ ...value, savedCount: list.length });
  };

  return (
    <section className="mb-4 rounded-xl border hairline bg-[#101b25] p-3" data-testid="head-unit-panel">
      <div className="mono text-[10px] text-[#7c909d] mb-2">МУЛЬТИМЕДИА · 7″ ШГУ</div>
      <div className="flex flex-wrap gap-1 mb-3">
        {HEAD_UNIT_MODES.map((mode) => (
          <button key={mode.id} type="button" className={`btn btn-mini ${value.mode === mode.id ? "border-[#52d6bd]/60 text-[#52d6bd]" : ""}`} onClick={() => chooseMode(mode.id)} aria-pressed={value.mode === mode.id}>
            {mode.short}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] mb-2">
        <div className="min-w-0">
          <div className="font-bold text-[#d3e0e7] truncate">{station.name} · FM {station.freq}</div>
          <div className="text-[10px] text-[#8fa2ae]">{station.genre} · {value.streamStatus === "live" ? "эфир" : value.streamStatus === "connecting" ? "подключение…" : value.streamStatus === "error" ? "ошибка" : "ожидание"}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" className="btn btn-mini" aria-label="Предыдущая станция" onClick={() => onChange({ ...value, stationIndex: stepStation(-1), source: "stream", savedTrackKey: null, radioPlaying: true, mode: "radio", streamStatus: "connecting" })}>◀</button>
          <button type="button" className="btn btn-mini" aria-label={value.radioPlaying ? "Пауза радио" : "Воспроизвести радио"} onClick={() => onChange({ ...value, mode: "radio", source: "stream", savedTrackKey: null, radioPlaying: !value.radioPlaying, streamStatus: "idle" })}>{value.radioPlaying ? "Ⅱ" : "▶"}</button>
          <button type="button" className="btn btn-mini" aria-label="Следующая станция" onClick={() => onChange({ ...value, stationIndex: stepStation(1), source: "stream", savedTrackKey: null, radioPlaying: true, mode: "radio", streamStatus: "connecting" })}>▶|</button>
        </div>
      </div>
      <label className="block text-[10px] text-[#9bafbc] mb-2">
        Громкость: {Math.round(value.volume * 100)}%
        <input className="w-full mt-1" type="range" min="0" max="1" step="0.01" value={value.volume} onChange={(e) => onChange({ ...value, volume: clampVolume(Number(e.target.value)) })} />
      </label>
      <div className="flex gap-2 mb-2">
        <button type="button" className="btn btn-mini flex-1" onClick={() => void saveOffline()}>Сохранить офлайн (24 с)</button>
        <span className="text-[10px] text-[#8fa2ae] self-center">Треков: {tracks.length}</span>
      </div>
      {tracks.length > 0 && (
        <div className="space-y-1 max-h-28 overflow-y-auto">
          {tracks.map((track) => (
            <div key={track.key} className="flex items-center gap-2 text-[10px]">
              <button type="button" className="text-left flex-1 min-w-0 text-[#d3e0e7] truncate hover:text-[#52d6bd]" onClick={() => playSaved(track)}>
                {track.stationName} · {formatTrackDuration(track.seconds)}
              </button>
              <button type="button" className="text-[#8fa2ae] hover:text-red-300" aria-label={`Удалить ${track.stationName}`} onClick={() => void deleteSaved(track.key)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-white/10 pt-2 mt-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="mono text-[10px] text-[#7c909d]">ЗВУК АВТОМОБИЛЯ</span>
          <label className="flex items-center gap-2 text-[10px] text-[#d3e0e7]">
            <input type="checkbox" checked={soundEnabled} onChange={(e) => onSoundEnabledChange(e.target.checked)} className="accent-[#52d6bd]" />
            Звук включён
          </label>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {([
            ["engine", "ДВС / шины"],
            ["horn", "Клаксон"],
            ["indicator", "Реле"],
          ] as const).map(([layer, label]) => (
            <label key={layer} className="flex items-center gap-1 text-[10px] text-[#9bafbc]">
              <input type="checkbox" checked={soundLayers[layer]} onChange={() => onSoundLayerToggle(layer)} disabled={!soundEnabled} className="accent-[#52d6bd]" />
              {label}
            </label>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-[#f5b942] mt-2" role="status">{message}</p>
      <audio ref={audioRef} preload="none" className="hidden" />
    </section>
  );
}
