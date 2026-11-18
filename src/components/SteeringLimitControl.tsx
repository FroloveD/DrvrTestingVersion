/**
 * @module components/SteeringLimitControl
 * @layer ui
 * @role Ползунок калибровки предела внутреннего переднего колеса (33–42°, шаг 0,5°) с живым расчётом Аккермана и радиуса.
 * @invariants #10 (руль ±540°, базовый выворот 35°, диапазон 33–42°).
 * @tests T23, T24, смоук L (`tests/browser-smoke.mjs`)
 */
import { useId } from "react";
import { ackermannAngle, centralSteerLimit, normalizeWheelLock, outerTurningRadius, WHEEL_LOCK } from "../sim/vehicle";

const format = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 1 });

/** Общий регулятор для HUD и кабинета инструктора. Угол относится к колёсам, а не к рулевому ободу. */
export function SteeringLimitControl({ value, onChange }: { value?: number; onChange: (angle: number) => void }) {
  const id = useId();
  const limit = normalizeWheelLock(value);
  const center = centralSteerLimit(limit);
  const outer = (ackermannAngle(-1, center) * 180) / Math.PI;
  return (
    <section className="wheel-lock-control" aria-label="Геометрия руления">
      <div className="wheel-lock-heading">
        <div>
          <label htmlFor={id}>Выворот колёс</label>
          <p>Предел внутреннего колеса</p>
        </div>
        <output htmlFor={id} className="wheel-lock-value mono">{format(limit)}<small>°</small></output>
      </div>
      <input id={id} aria-label="Максимальный угол поворота внутреннего колеса" type="range"
        min={WHEEL_LOCK.min} max={WHEEL_LOCK.max} step={WHEEL_LOCK.step} value={limit}
        aria-valuetext={`${format(limit)}°`} onChange={(e) => onChange(normalizeWheelLock(e.currentTarget.valueAsNumber))}
        style={{ background: `linear-gradient(90deg, #f5b942 ${(limit - WHEEL_LOCK.min) * 100 / (WHEEL_LOCK.max - WHEEL_LOCK.min)}%, #34424c 0)` }} />
      <div className="wheel-lock-scale mono"><span>33°</span>
        <button type="button" onClick={() => onChange(WHEEL_LOCK.defaultDeg)} title="Вернуть базовый выворот 35°">Базовый · 35°</button>
        <span>42°</span>
      </div>
      <div className="wheel-lock-details">
        <svg width="60" height="36" viewBox="0 0 60 36" fill="none" aria-hidden="true">
          <path d="M7 18h46M30 6v24" stroke="#677c89" strokeDasharray="3 2" />
          {[[11, limit], [49, outer]].map(([cx, angle]) => (
            <g key={cx} transform={`rotate(${-angle} ${cx} 18)`}>
              <rect x={cx - 4} y="8" width="8" height="20" rx="2" fill="#1e3035" stroke="#70c6b6" />
              <path d={`M${cx - 2} 11h4m-4 4h4m-4 4h4m-4 4h4`} stroke="#70c6b6" strokeWidth="1" />
            </g>
          ))}
        </svg>
        <div><span>Внешнее колесо</span><b className="mono">{format(outer)}°</b></div>
        <div title="Радиус по внешнему переднему углу кузова при полном вывороте"><span>Внешний радиус</span><b className="mono">{format(outerTurningRadius(center))} м</b></div>
      </div>
    </section>
  );
}
