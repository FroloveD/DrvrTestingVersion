/**
 * @module components/GamepadPanel
 * @layer ui
 * @role Панель подключения и 5-шаговой калибровки USB-руля, педалей и стандартного геймпада.
 * @invariants Устройство выключено по умолчанию; привязка к `deviceId`; настройка мёртвых зон.
 * @tests T17, смоук E (`tests/browser-smoke.mjs`)
 */
import { useEffect, useRef, useState } from "react";
import { readBrowserGamepad } from "../input/browserGamepads";
import {
  CALIB_PROMPT,
  advanceCalibration,
  createAxisArming,
  createDefaultProfile,
  isStandardGamepad,
  presetForStandardGamepad,
  readGamepad,
  startCalibration,
  updateAxisArming,
  type CalibState,
  type GamepadProfile,
  type GamepadSnapshot,
} from "../input/gamepad";
import { Icon } from "./Icons";

type Props = {
  profile: GamepadProfile;
  onChange: (next: GamepadProfile) => void;
  onNotify: (msg: string) => void;
};

/**
 * Панель USB-руля / педалей / геймпада: подключение, включение, калибровка по шагам
 * и живые показания. Опрашивает устройство сама, пока открыта.
 */
export function GamepadPanel({ profile, onChange, onNotify }: Props) {
  const [snap, setSnap] = useState<GamepadSnapshot | null>(null);
  const [calib, setCalib] = useState<CalibState | null>(null);
  const [calibError, setCalibError] = useState<string | null>(null);
  const armingRef = useRef(createAxisArming());
  const preferredIdRef = useRef(profile.deviceId);

  useEffect(() => {
    preferredIdRef.current = calib ? calib.baseline.id : profile.deviceId;
  }, [calib, profile.deviceId]);

  useEffect(() => {
    const poll = () => {
      const next = readBrowserGamepad(preferredIdRef.current);
      updateAxisArming(armingRef.current, next);
      setSnap(next);
    };
    poll();
    const timer = window.setInterval(poll, 120);
    return () => window.clearInterval(timer);
  }, []);

  const standard = snap ? isStandardGamepad(snap) : false;
  const configured = Boolean(snap && profile.calibrated && profile.deviceId === snap.id);
  const controlling = configured && profile.enabled;
  const live = snap && configured ? readGamepad(snap, { ...profile, enabled: true }, armingRef.current) : null;

  const beginCalibration = () => {
    if (!snap) {
      onNotify("Устройство не найдено: подключите его и нажмите на нём любую кнопку");
      return;
    }
    // На время калибровки устройство не управляет машиной
    if (profile.enabled) onChange({ ...profile, enabled: false });
    setCalibError(null);
    setCalib(startCalibration(snap, profile));
  };

  const advance = (skipPedal: boolean) => {
    if (!calib) return;
    const fresh = readBrowserGamepad(calib.baseline.id);
    if (!fresh) {
      setCalibError("Устройство не отвечает: проверьте подключение.");
      return;
    }
    const result = advanceCalibration(calib, fresh, skipPedal);
    if (result.error) {
      setCalibError(result.error);
      return;
    }
    setCalibError(null);
    if (result.state.step === "done") {
      onChange(result.state.draft);
      setCalib(null);
      onNotify("Калибровка завершена: устройство включено");
    } else {
      setCalib(result.state);
    }
  };

  const toggleEnabled = (checked: boolean) => {
    if (!checked) {
      onChange({ ...profile, enabled: false });
      return;
    }
    if (!snap) {
      onNotify("Устройство не найдено: подключите его и нажмите на нём любую кнопку");
      return;
    }
    if (configured) {
      onChange({ ...profile, enabled: true });
      return;
    }
    if (standard) {
      onChange({ ...presetForStandardGamepad(snap), enabled: true });
      onNotify("Геймпад включён: левый стик — руль, RT — газ, LT — тормоз");
      return;
    }
    beginCalibration();
  };

  const statusLabel = !snap ? "НЕ НАЙДЕНО" : controlling ? "УПРАВЛЯЕТ" : configured ? "ГОТОВО" : "НЕ НАСТРОЕНО";
  const statusClass = controlling
    ? "bg-[#52d6bd]/15 text-[#52d6bd]"
    : snap
      ? "bg-[#f5b942]/15 text-[#f5b942]"
      : "bg-white/10 text-[#8fa2ae]";

  return (
    <div className="mt-3 pt-3 border-t hairline">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-bold text-[#d3e0e7]">Руль / педали (USB)</span>
        <span className={`mono text-[9px] px-1.5 py-0.5 rounded ${statusClass}`}>{statusLabel}</span>
      </div>

      {!snap ? (
        <div className="text-[10px] text-[#7c909d] leading-relaxed mb-2">
          Подключите устройство и нажмите на нём любую кнопку: браузер показывает устройства только после
          нажатия. Без устройства всё управление остаётся на клавиатуре, мыши и экране.
        </div>
      ) : (
        <>
          <div className="mono text-[9px] text-[#7c909d] truncate" title={snap.id}>
            {snap.id}
          </div>
          <div className="mono text-[9px] text-[#6e8492] mb-2">
            {snap.axes.length} осей · {snap.buttons.length} кнопок ·{" "}
            {standard ? "стандартная раскладка" : "раскладка зависит от модели"}
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-[#d3e0e7] cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={controlling}
              disabled={calib !== null}
              onChange={(e) => toggleEnabled(e.target.checked)}
            />
            Использовать устройство
          </label>

          {!configured && !standard && !calib && (
            <div className="text-[10px] text-[#f5d78a] leading-relaxed mb-2">
              Этому устройству нужна калибровка: номера осей и полярность педалей у рулей зависят от модели
              и драйвера, угадывать их нельзя.
            </div>
          )}

          {calib && (
            <div className="panel-soft p-2.5 mb-2 border-[#f5b942]/40">
              <div className="text-[10px] text-[#f5d78a] leading-snug">{CALIB_PROMPT[calib.step]}</div>
              {calibError && <div className="text-[10px] text-[#ff9494] leading-snug mt-1.5">{calibError}</div>}
              <div className="flex gap-1.5 mt-2">
                <button type="button" className="btn btn-primary btn-mini flex-1" onClick={() => advance(false)}>
                  Далее
                </button>
                {(calib.step === "throttleFull" || calib.step === "brakeFull") && (
                  <button type="button" className="btn btn-mini" onClick={() => advance(true)}>
                    Нет педали
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => {
                    setCalib(null);
                    setCalibError(null);
                  }}
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          {live && (
            <div className="space-y-1.5 mb-2">
              {(
                [
                  ["ГАЗ", live.throttle, `${Math.round(live.throttle * 100)}%`],
                  ["ТОРМОЗ", live.brake, `${Math.round(live.brake * 100)}%`],
                  ["РУЛЬ", Math.abs(live.steerWheelDeg) / 540, `${Math.round(live.steerWheelDeg)}°`],
                ] as const
              ).map(([label, value, text]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="mono text-[8px] text-[#6e8492] w-12">{label}</span>
                  <span className="flex-1 h-1.5 rounded bg-[rgba(148,176,194,.14)] overflow-hidden">
                    <span
                      className="block h-full bg-[#52d6bd]"
                      style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
                    />
                  </span>
                  <span className="mono text-[8px] text-[#8fa2ae] w-10 text-right">{text}</span>
                </div>
              ))}
              <div className="mono text-[8px] text-[#5b6f7d]">
                Руль: плюс — влево. Педаль покажет ход после первого нажатия.
              </div>
            </div>
          )}

          <div className="mono text-[8px] text-[#5b6f7d] truncate mb-2" title="Сырые значения осей устройства">
            оси: {snap.axes.slice(0, 8).map((v) => v.toFixed(2)).join("  ")}
          </div>

          {configured && !calib && (
            <div className="space-y-1 mb-2">
              <label className="flex items-center gap-1.5 text-[10px] text-[#9bafbc] cursor-pointer">
                <input
                  type="checkbox"
                  checked={profile.invertSteer}
                  onChange={(e) => onChange({ ...profile, invertSteer: e.target.checked })}
                />
                Руль работает наоборот — перевернуть
              </label>
              <label className="block text-[10px] text-[#9bafbc]">
                Диапазон руля: <b className="mono text-[#f5b942]">±{profile.steerRangeDeg}°</b>
                <input
                  type="range"
                  min={90}
                  max={540}
                  step={10}
                  value={profile.steerRangeDeg}
                  onChange={(e) => onChange({ ...profile, steerRangeDeg: Number(e.target.value) })}
                  className="w-full"
                />
              </label>
              <label className="block text-[10px] text-[#9bafbc]">
                Мёртвая зона руля: <b className="mono text-[#f5b942]">{Math.round(profile.steerDeadzone * 100)}%</b>
                <input
                  type="range"
                  min={0}
                  max={0.3}
                  step={0.01}
                  value={profile.steerDeadzone}
                  onChange={(e) => onChange({ ...profile, steerDeadzone: Number(e.target.value) })}
                  className="w-full"
                />
              </label>
            </div>
          )}

          {!calib && (
            <div className="flex gap-1.5">
              <button type="button" className="btn btn-mini flex-1" onClick={beginCalibration}>
                <Icon name="target" size={11} /> {configured ? "Перекалибровать" : "Калибровать"}
              </button>
              <button
                type="button"
                className="btn btn-mini"
                title="Сбросить профиль устройства"
                onClick={() => {
                  onChange(createDefaultProfile());
                  onNotify("Профиль устройства сброшен: управление только с клавиатуры и экрана");
                }}
              >
                <Icon name="reset" size={11} />
              </button>
            </div>
          )}
        </>
      )}

      <div className="mono text-[8px] text-[#5b6f7d] leading-relaxed mt-2">
        Одно устройство за раз: педали должны идти через базу руля. Кнопки руля не назначаются — двигатель,
        передачи и поворотники остаются на клавиатуре и экране.
      </div>
    </div>
  );
}
