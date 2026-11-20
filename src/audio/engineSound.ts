/**
 * @module audio/engineSound
 * @layer three-render
 * @role Процедурный звук ДВС 1.6 MPI через Web Audio: низкий приглушённый тон с пульсацией тактов, нагрузка по дросселю, шины, клаксон и щелчок реле поворотника.
 * @invariants #8 (100 % офлайн, никаких сетевых ассетов), #13 (не запускается без пользовательского жеста и не шумит в покое).
 * @tests Смоук K7e (`tests/browser-smoke.mjs`) — слои звука, клаксон и переключатели без ошибок консоли.
 */

export type EngineSoundState = {
  engineOn: boolean;
  rpm: number;
  throttle: number;
  speedKmh: number;
  /** Нажат сигнал (клаксон). */
  horn?: boolean;
};

/** Независимые слои звука — каждый отключается своей кнопкой в панели ШГУ. */
export type SoundLayers = { engine: boolean; horn: boolean; indicator: boolean };

type Nodes = {
  ctx: AudioContext;
  master: GainNode;
  engineGain: GainNode;
  engineOsc: OscillatorNode;
  engineOsc2: OscillatorNode;
  engineFilter: BiquadFilterNode;
  /** Тактовый гейт: короткие провалы громкости в фазе вспышки — «тарахтение», а не гул. */
  strokeGate: GainNode;
  strokeGain: GainNode;
  strokeOsc: OscillatorNode;
  tyreGain: GainNode;
  tyreNoise: AudioBufferSourceNode;
  hornGain: GainNode;
  hornOsc: OscillatorNode;
  hornOsc2: OscillatorNode;
  noiseGain: GainNode;
  noiseFilter: BiquadFilterNode;
  /** Общий буфер шума для шин и щелчка реле. */
  noiseBuffer: AudioBuffer;
  clickSrc: AudioBufferSourceNode;
};

/** Процедурный синтезатор звука автомобиля: ДВС, выхлоп и шум шин. */
export class EngineSound {
  private nodes: Nodes | null = null;
  private enabled = true;
  private layers: SoundLayers = { engine: true, horn: true, indicator: true };
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

      // --- ДВС: низкий приглушённый тембр ---
      const engineGain = ctx.createGain();
      engineGain.gain.value = 0.0001;
      const engineFilter = ctx.createBiquadFilter();
      engineFilter.type = "lowpass";
      engineFilter.frequency.value = 480;
      engineFilter.Q.value = 0.7;
      const engineOsc = ctx.createOscillator();
      engineOsc.type = "sawtooth";
      engineOsc.frequency.value = 24;
      const engineOsc2 = ctx.createOscillator();
      engineOsc2.type = "triangle";
      engineOsc2.frequency.value = 48;
      const osc2Gain = ctx.createGain();
      osc2Gain.gain.value = 0.34;
      // Высокие гармоники почти убраны: тон обязан быть низким и глухим, «под одеялом»
      const toneLp = ctx.createBiquadFilter();
      toneLp.type = "lowpass";
      toneLp.frequency.value = 620;
      toneLp.Q.value = 0.5;
      engineOsc.connect(engineFilter);
      engineOsc2.connect(osc2Gain).connect(engineFilter);
      engineFilter.connect(toneLp);

      // Тактовый гейт: синус на частоте вспышек режет громкость в фазе вспышки — слышно «тарахтение»
      const strokeGate = ctx.createGain();
      strokeGate.gain.value = 0.62;
      const strokeOsc = ctx.createOscillator();
      strokeOsc.type = "sine";
      strokeOsc.frequency.value = 24;
      const strokeGain = ctx.createGain();
      strokeGain.gain.value = 0.34;
      strokeOsc.connect(strokeGain).connect(strokeGate.gain);
      strokeOsc.start();
      toneLp.connect(strokeGate).connect(engineGain).connect(master);
      engineOsc.start();
      engineOsc2.start();

      // Детерминированный буфер шума: шины и щелчок реле поворотника
      const noiseLen = Math.floor(ctx.sampleRate * 1.2);
      const noiseBuffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      let seed = 1337;
      for (let i = 0; i < noiseLen; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = ((seed / 0xffffffff) * 2 - 1) * 0.5;
      }
      const tyreNoise = ctx.createBufferSource();
      tyreNoise.buffer = noiseBuffer;
      tyreNoise.loop = true;
      const tyreFilter = ctx.createBiquadFilter();
      tyreFilter.type = "bandpass";
      tyreFilter.frequency.value = 320;
      tyreFilter.Q.value = 0.7;
      const tyreGain = ctx.createGain();
      tyreGain.gain.value = 0.0001;
      tyreNoise.connect(tyreFilter).connect(tyreGain).connect(master);
      tyreNoise.start();

      // --- Клаксон: двухтональный электрический сигнал 415 + 500 Гц ---
      const hornGain = ctx.createGain();
      hornGain.gain.value = 0.0001;
      const hornOsc = ctx.createOscillator();
      hornOsc.type = "square";
      hornOsc.frequency.value = 415;
      const hornOsc2 = ctx.createOscillator();
      hornOsc2.type = "sawtooth";
      hornOsc2.frequency.value = 500;
      const hornLp = ctx.createBiquadFilter();
      hornLp.type = "lowpass";
      hornLp.frequency.value = 2100;
      const horn2Gain = ctx.createGain();
      horn2Gain.gain.value = 0.5;
      hornOsc.connect(hornLp);
      hornOsc2.connect(horn2Gain).connect(hornLp);
      hornLp.connect(hornGain).connect(master);
      hornOsc.start();
      hornOsc2.start();

      // --- Щелчок реле поворотника: короткая шумовая вспышка через полосовой фильтр ---
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.0001;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.frequency.value = 1600;
      noiseFilter.Q.value = 1.6;
      const clickSrc = ctx.createBufferSource();
      clickSrc.buffer = noiseBuffer;
      clickSrc.loop = true;
      clickSrc.connect(noiseFilter).connect(noiseGain).connect(master);
      clickSrc.start();

      this.nodes = {
        ctx,
        master,
        engineGain,
        engineOsc,
        engineOsc2,
        engineFilter,
        strokeGate,
        strokeGain,
        strokeOsc,
        tyreGain,
        tyreNoise,
        hornGain,
        hornOsc,
        hornOsc2,
        noiseGain,
        noiseFilter,
        noiseBuffer,
        clickSrc,
      };
      void ctx.resume().catch(() => undefined);
      this.apply(this.lastState);
      return true;
    } catch {
      this.nodes = null;
      return false;
    }
  }

  /** Включает/выключает ВЕСЬ звук тренажёра: ДВС, шины, клаксон, реле поворотника. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const n = this.nodes;
    if (!n) return;
    n.master.gain.setTargetAtTime(enabled ? this.volume : 0, n.ctx.currentTime, 0.05);
  }

  /**
   * Отключение отдельных слоёв: `engine` (ДВС и шины), `horn` (сигнал), `indicator` (реле поворотника).
   * Мастер-выключатель `setEnabled(false)` глушит всё сразу, независимо от слоёв.
   */
  setLayers(layers: Partial<SoundLayers>): void {
    this.layers = { ...this.layers, ...layers };
    const n = this.nodes;
    if (!n) return;
    const now = n.ctx.currentTime;
    if (!this.layers.engine) {
      n.engineGain.gain.setTargetAtTime(0.0001, now, 0.06);
      n.tyreGain.gain.setTargetAtTime(0.0001, now, 0.08);
    }
    if (!this.layers.horn) n.hornGain.gain.setTargetAtTime(0.0001, now, 0.02);
    if (!this.layers.indicator) n.noiseGain.gain.setTargetAtTime(0.0001, now, 0.02);
    this.apply(this.lastState);
  }

  /** Текущая конфигурация слоёв (для тестов и отладки). */
  getLayers(): SoundLayers {
    return { ...this.layers };
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
    // Клаксон живёт независимо от ДВС: сигналить можно и на заглушенной машине
    const hornOn = state.horn === true && this.layers.horn;
    n.hornGain.gain.setTargetAtTime(hornOn ? 0.055 : 0.0001, now, hornOn ? 0.012 : 0.03);

    if (!this.layers.engine || !state.engineOn || state.rpm < 30) {
      n.engineGain.gain.setTargetAtTime(0.0001, now, 0.08);
      n.tyreGain.gain.setTargetAtTime(0.0001, now, 0.12);
      return;
    }
    // Частота вспышек 4-цилиндрового рядника: об/мин ÷ 30 (800 об/мин → 26,7 Гц «пульса»)
    const fireHz = Math.max(12, state.rpm / 30);
    n.engineOsc.frequency.setTargetAtTime(fireHz, now, 0.06);
    n.engineOsc2.frequency.setTargetAtTime(fireHz * 2, now, 0.06);
    n.strokeOsc.frequency.setTargetAtTime(fireHz, now, 0.06);
    n.strokeGain.gain.setTargetAtTime(0.3 + Math.min(0.25, (state.rpm / 6500) * 0.25), now, 0.09);

    const load = Math.min(1, Math.max(0, state.throttle));
    const rpmFrac = Math.min(1, state.rpm / 6500);
    // Громкость снижена относительно прежней (было 0,02…0,13): мотор «в фоне», салон тише
    n.engineGain.gain.setTargetAtTime(0.012 + load * 0.042 + rpmFrac * 0.02, now, 0.07);
    // Фильтр открывается с оборотами, но остаётся глухим: 240…1150 Гц вместо 420…3900 Гц
    n.engineFilter.frequency.setTargetAtTime(240 + rpmFrac * 640 + load * 260, now, 0.09);

    const speedFrac = Math.min(1, state.speedKmh / 120);
    n.tyreGain.gain.setTargetAtTime(speedFrac > 0.02 ? 0.006 + speedFrac * 0.022 : 0.0001, now, 0.15);
  }

  /**
   * Щелчок реле указателя поворота / аварийки: короткая шумовая вспышка.
   * UI вызывает метод по переднему фронту фазы мигания (~1,5 Гц), своего таймера у синтезатора нет.
   */
  clickIndicator(): void {
    const n = this.nodes;
    if (!n || !this.enabled || !this.layers.indicator) return;
    const now = n.ctx.currentTime;
    n.noiseGain.gain.cancelScheduledValues(now);
    n.noiseGain.gain.setValueAtTime(0.02, now);
    n.noiseGain.gain.setTargetAtTime(0.0001, now + 0.012, 0.01);
  }

  /** Полная остановка и освобождение аудиографа (при размонтировании тренажёра). */
  dispose(): void {
    const n = this.nodes;
    this.nodes = null;
    if (!n) return;
    try {
      n.engineOsc.stop();
      n.engineOsc2.stop();
      n.strokeOsc.stop();
      n.hornOsc.stop();
      n.hornOsc2.stop();
      n.clickSrc.stop();
      n.tyreNoise.stop();
      void n.ctx.close().catch(() => undefined);
    } catch {
      // граф уже остановлен
    }
  }
}
