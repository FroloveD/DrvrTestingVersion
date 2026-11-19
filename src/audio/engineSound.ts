/**
 * @module audio/engineSound
 * @layer three-render
 * @role Процедурный звук ДВС 1.6 MPI и трансмиссии через Web Audio (без внешних файлов): тон по оборотам, нагрузка по дросселю, шум шин по скорости.
 * @invariants #8 (100 % офлайн, никаких сетевых ассетов), #13 (не запускается без пользовательского жеста и не шумит в покое).
 * @tests Смоук K7e (`tests/browser-smoke.mjs`) — создание/переключение без ошибок консоли.
 */

export type EngineSoundState = {
  engineOn: boolean;
  rpm: number;
  throttle: number;
  speedKmh: number;
};

type Nodes = {
  ctx: AudioContext;
  master: GainNode;
  engineGain: GainNode;
  engineOsc: OscillatorNode;
  engineOsc2: OscillatorNode;
  engineFilter: BiquadFilterNode;
  tyreGain: GainNode;
  tyreNoise: AudioBufferSourceNode;
};

/** Процедурный синтезатор звука автомобиля: ДВС, выхлоп и шум шин. */
export class EngineSound {
  private nodes: Nodes | null = null;
  private enabled = true;
  private volume = 0.5;
  private lastState: EngineSoundState = { engineOn: false, rpm: 0, throttle: 0, speedKmh: 0 };

  /** Создаёт аудиограф по первому пользовательскому жесту (политика автозапуска браузеров). */
  ensureStarted(): boolean {
    if (this.nodes) {
      if (this.nodes.ctx.state === "suspended") void this.nodes.ctx.resume().catch(() => undefined);
      return true;
    }
    const ctor =
      typeof window !== "undefined"
        ? window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!ctor) return false;
    try {
      const ctx = new ctor();
      const master = ctx.createGain();
      master.gain.value = this.enabled ? this.volume : 0;
      master.connect(ctx.destination);

      const engineGain = ctx.createGain();
      engineGain.gain.value = 0.0001;
      const engineFilter = ctx.createBiquadFilter();
      engineFilter.type = "lowpass";
      engineFilter.frequency.value = 900;
      engineFilter.Q.value = 0.9;
      const engineOsc = ctx.createOscillator();
      engineOsc.type = "sawtooth";
      engineOsc.frequency.value = 40;
      const engineOsc2 = ctx.createOscillator();
      engineOsc2.type = "square";
      engineOsc2.frequency.value = 80;
      const osc2Gain = ctx.createGain();
      osc2Gain.gain.value = 0.28;
      engineOsc.connect(engineFilter);
      engineOsc2.connect(osc2Gain).connect(engineFilter);
      engineFilter.connect(engineGain).connect(master);
      engineOsc.start();
      engineOsc2.start();

      // Шум шин — детерминированный буфер белого шума, воспроизводится по кругу
      const noiseLen = Math.floor(ctx.sampleRate * 1.2);
      const buffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let seed = 1337;
      for (let i = 0; i < noiseLen; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = ((seed / 0xffffffff) * 2 - 1) * 0.5;
      }
      const tyreNoise = ctx.createBufferSource();
      tyreNoise.buffer = buffer;
      tyreNoise.loop = true;
      const tyreFilter = ctx.createBiquadFilter();
      tyreFilter.type = "bandpass";
      tyreFilter.frequency.value = 320;
      tyreFilter.Q.value = 0.7;
      const tyreGain = ctx.createGain();
      tyreGain.gain.value = 0.0001;
      tyreNoise.connect(tyreFilter).connect(tyreGain).connect(master);
      tyreNoise.start();

      this.nodes = { ctx, master, engineGain, engineOsc, engineOsc2, engineFilter, tyreGain, tyreNoise };
      void ctx.resume().catch(() => undefined);
      this.apply(this.lastState);
      return true;
    } catch {
      this.nodes = null;
      return false;
    }
  }

  /** Включает/выключает весь звук (ДВС + шины). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const n = this.nodes;
    if (!n) return;
    n.master.gain.setTargetAtTime(enabled ? this.volume : 0, n.ctx.currentTime, 0.05);
  }

  /** Мастер-громкость 0..1. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    const n = this.nodes;
    if (!n) return;
    n.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, n.ctx.currentTime, 0.05);
  }

  /**
   * Обновляет тон ДВС по оборотам и нагрузке.
   * Основной тон — частота вспышек 4-цилиндрового рядного двигателя (об/мин ÷ 30),
   * фильтр открывается с ростом оборотов, громкость — от дросселя и оборотов.
   */
  update(state: EngineSoundState): void {
    this.lastState = state;
    this.apply(state);
  }

  private apply(state: EngineSoundState): void {
    const n = this.nodes;
    if (!n) return;
    const now = n.ctx.currentTime;
    if (!state.engineOn || state.rpm < 30) {
      n.engineGain.gain.setTargetAtTime(0.0001, now, 0.08);
      n.tyreGain.gain.setTargetAtTime(0.0001, now, 0.12);
      return;
    }
    const fireHz = Math.max(18, state.rpm / 30);
    n.engineOsc.frequency.setTargetAtTime(fireHz, now, 0.06);
    n.engineOsc2.frequency.setTargetAtTime(fireHz * 2, now, 0.06);
    const load = Math.min(1, Math.max(0, state.throttle));
    const rpmFrac = Math.min(1, state.rpm / 6500);
    const target = 0.02 + load * 0.075 + rpmFrac * 0.035;
    n.engineGain.gain.setTargetAtTime(target, now, 0.07);
    n.engineFilter.frequency.setTargetAtTime(420 + rpmFrac * 2600 + load * 900, now, 0.09);

    const speedFrac = Math.min(1, state.speedKmh / 120);
    n.tyreGain.gain.setTargetAtTime(speedFrac > 0.02 ? 0.008 + speedFrac * 0.032 : 0.0001, now, 0.15);
  }

  /** Полная остановка и освобождение аудиографа (при размонтировании тренажёра). */
  dispose(): void {
    const n = this.nodes;
    this.nodes = null;
    if (!n) return;
    try {
      n.engineOsc.stop();
      n.engineOsc2.stop();
      n.tyreNoise.stop();
      void n.ctx.close().catch(() => undefined);
    } catch {
      // граф уже остановлен
    }
  }
}
