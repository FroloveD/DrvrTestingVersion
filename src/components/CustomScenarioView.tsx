/**
 * @module components/CustomScenarioView
 * @layer ui
 * @role Конструктор «Свой сценарий»: редактирование боксов, препятствий и КТ, валидация, 2D-схема и JSON-обмен.
 * @invariants #1 (координаты на 2D-схеме), #15 (сохранение снимка мира в попытке).
 * @tests T16 (`src/sim/selfTest.ts`), смоук A (`tests/browser-smoke.mjs`)
 *
 * Оглавление секций (`grep -n "SEC:custom-"`):
 * - `[SEC:custom-fields]`  — числовые и текстовые поля редактора (`NumField`, `TextField`).
 * - `[SEC:custom-forms]`   — формы параметров площадки, боксов, препятствий и контрольных точек.
 * - `[SEC:custom-preview]` — интерактивная 2D-схема сценария и диагностика ошибок геометрии.
 */
import { useMemo, useRef } from "react";
import { buildParallelScenario, buildPerpendicularScenario } from "../scenarios/catalog";
import {
  customFromWorld,
  defaultCustomScenario,
  nextBayId,
  nextCheckpointId,
  nextObstacleId,
  validateCustomScenario,
  type CustomScenarioDef,
} from "../scenarios/custom";
import type {
  CalibrationConfig,
  ObstacleKind,
  ParkedModelKey,
  ParkingBayKind,
} from "../sim/types";
import { Chip, downloadJson, Icon } from "./Icons";

type Props = {
  def: CustomScenarioDef;
  onChange: (next: CustomScenarioDef) => void;
  calibration: CalibrationConfig;
  onOpenInSimulator: () => void;
  onNotify: (msg: string) => void;
};

const radToDeg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 10) / 10;
const degToRad = (deg: number) => (deg * Math.PI) / 180;

// === [SEC:custom-fields] Вспомогательные поля ввода редактора ===
function NumField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block min-w-0">
      <span className="mono text-[10px] text-[#7c909d] block mb-1">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 mono text-xs text-white"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mono text-[10px] text-[#7c909d] block mb-1">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white"
      />
    </label>
  );
}

const BAY_KINDS: Array<{ v: ParkingBayKind; l: string }> = [
  { v: "perpendicular", l: "Перпендикулярный 90°" },
  { v: "parallel", l: "Параллельный карман" },
];

const OBSTACLE_KINDS: Array<{ v: ObstacleKind; l: string }> = [
  { v: "curb", l: "Бордюр" },
  { v: "cone", l: "Конус" },
  { v: "building", l: "Здание" },
  { v: "pole", l: "Столб" },
  { v: "parked_car", l: "Припаркованный авто" },
];

const PARKED_MODELS: ParkedModelKey[] = ["picanto", "rio", "ceed", "xceed", "sorento"];

export function CustomScenarioView({ def, onChange, calibration, onOpenInSimulator, onNotify }: Props) {
  const importRef = useRef<HTMLInputElement | null>(null);
  const validation = useMemo(() => validateCustomScenario(def), [def]);
  const blocked = validation.errors.length > 0;

  const setDef = (patch: Partial<CustomScenarioDef>) => onChange({ ...def, ...patch });

  // 2D-превью: sx = −x, sy = −z (+Z вверх, +X влево — как в разборе)
  const vb = useMemo(() => {
    const pad = 3;
    const x = -def.bounds.maxX - pad;
    const y = -def.bounds.maxZ - pad;
    const w = def.bounds.maxX - def.bounds.minX + pad * 2;
    const h = def.bounds.maxZ - def.bounds.minZ + pad * 2;
    return { x, y, w: Math.max(10, w), h: Math.max(10, h) };
  }, [def.bounds]);

  const handlePreviewClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const sx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
    const sy = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
    const x = Number((-sx).toFixed(1));
    const z = Number((-sy).toFixed(1));
    if (
      x < def.bounds.minX ||
      x > def.bounds.maxX ||
      z < def.bounds.minZ ||
      z > def.bounds.maxZ
    ) {
      onNotify("Клик за границами мира — старт не перемещён");
      return;
    }
    onChange({ ...def, start: { ...def.start, x, z } });
  };

  const startTipX = -(def.start.x + Math.sin(def.start.h) * 2.4);
  const startTipY = -(def.start.z + Math.cos(def.start.h) * 2.4);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<CustomScenarioDef>;
      if (!parsed || !Array.isArray(parsed.bays) || !Array.isArray(parsed.obstacles) || !parsed.start) {
        throw new Error("Неверная схема файла сценария (нужны bays, obstacles, start)");
      }
      onChange({ ...defaultCustomScenario(), ...parsed, version: 1 });
      onNotify(`Сценарий «${parsed.title || file.name}» загружен в редактор`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось прочитать файл сценария");
    }
  };

  const loadTemplateBay90 = () => {
    onChange(customFromWorld(buildPerpendicularScenario(calibration), "Мой бокс 90°"));
    onNotify("Шаблон: копия сценария «Бокс 90°»");
  };
  const loadTemplateParallel = () => {
    onChange(customFromWorld(buildParallelScenario(calibration), "Моя параллельная парковка"));
    onNotify("Шаблон: копия сценария «Параллельная парковка»");
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Сценарии как данные</Chip>
            <Chip tone={blocked ? "red" : "mint"}>
              {blocked ? `Ошибок: ${validation.errors.length}` : "Готов к заезду"}
            </Chip>
            {validation.warnings.length > 0 && (
              <Chip tone="amber">Предупреждений: {validation.warnings.length}</Chip>
            )}
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Свой сценарий</h2>
          <p className="text-[13px] text-[#9bafbc] mt-1">
            Конструктор упражнений для инструктора: боксы, препятствия и точки маршрута — без правки кода.
            Сценарий сохраняется в браузере и открывается в 3D-тренажёре четвёртым пунктом.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImport} />
          <button type="button" className="btn btn-mini" onClick={() => importRef.current?.click()}>
            <Icon name="upload" size={13} /> Импорт JSON
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => downloadJson("custom-scenario.json", def, onNotify)}
          >
            <Icon name="download" size={13} /> Скачать JSON
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              onChange(defaultCustomScenario());
              onNotify("Восстановлен стартовый шаблон");
            }}
          >
            <Icon name="reset" size={13} /> Шаблон
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocked}
            title={blocked ? "Исправьте ошибки валидации" : "Открыть сценарий в 3D-тренажёре"}
            onClick={onOpenInSimulator}
          >
            <Icon name="car" size={15} /> Открыть в тренажёре →
          </button>
        </div>
      </div>

      {(blocked || validation.warnings.length > 0) && (
        <div className="panel p-4 space-y-1.5">
          {validation.errors.map((e, i) => (
            <div key={`e${i}`} className="flex gap-2 text-[12px] text-[#ff9494]">
              <Icon name="alert" size={14} className="shrink-0 mt-0.5" />
              <span>{e}</span>
            </div>
          ))}
          {validation.warnings.map((w, i) => (
            <div key={`w${i}`} className="flex gap-2 text-[12px] text-[#f5d78a]">
              <Icon name="alert" size={14} className="shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_380px] gap-4 items-start">
        {/* [SEC:custom-forms] Левая колонка: формы боксов, препятствий и точек маршрута */}
        <div className="space-y-4 min-w-0">
          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-xs font-extrabold">Общие параметры</div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="btn btn-mini" onClick={loadTemplateBay90}>
                  Копия: Бокс 90°
                </button>
                <button type="button" className="btn btn-mini" onClick={loadTemplateParallel}>
                  Копия: Параллельная
                </button>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <TextField label="НАЗВАНИЕ" value={def.title} onChange={(v) => setDef({ title: v })} />
              <TextField label="ПОДЗАГОЛОВОК" value={def.subtitle} onChange={(v) => setDef({ subtitle: v })} />
            </div>
            <label className="block mt-3">
              <span className="mono text-[10px] text-[#7c909d] block mb-1">ЗАДАНИЕ ЭКЗАМЕНАТОРА</span>
              <textarea
                value={def.brief}
                onChange={(e) => setDef({ brief: e.target.value })}
                rows={2}
                className="w-full rounded-lg bg-[#091017] border hairline px-2 py-1.5 text-xs text-white resize-y"
              />
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              <NumField label="ЛИМИТ, КМ/Ч" value={def.defaultSpeedLimitKmh} min={5} max={90} step={5} onChange={(v) => setDef({ defaultSpeedLimitKmh: v })} />
              <NumField label="ПЛОЩАДКА ±X, М" value={def.lotHalfX} min={5} max={120} onChange={(v) => setDef({ lotHalfX: v })} />
              <NumField label="ПЛОЩАДКА ±Z, М" value={def.lotHalfZ} min={5} max={120} onChange={(v) => setDef({ lotHalfZ: v })} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              <NumField label="ГРАНИЦА MIN X" value={def.bounds.minX} step={1} onChange={(v) => setDef({ bounds: { ...def.bounds, minX: v } })} />
              <NumField label="ГРАНИЦА MAX X" value={def.bounds.maxX} step={1} onChange={(v) => setDef({ bounds: { ...def.bounds, maxX: v } })} />
              <NumField label="ГРАНИЦА MIN Z" value={def.bounds.minZ} step={1} onChange={(v) => setDef({ bounds: { ...def.bounds, minZ: v } })} />
              <NumField label="ГРАНИЦА MAX Z" value={def.bounds.maxZ} step={1} onChange={(v) => setDef({ bounds: { ...def.bounds, maxZ: v } })} />
            </div>
          </div>

          <div className="panel p-5">
            <div className="text-xs font-extrabold mb-1">Стартовая позиция</div>
            <div className="text-[11px] text-[#7c909d] mb-3">
              Клик по 2D-схеме справа тоже перемещает старт. Курс: ↑ 0° (на север), → −90°, ↓ 180°, ← +90°.
            </div>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="X, М" value={def.start.x} onChange={(v) => setDef({ start: { ...def.start, x: v } })} />
              <NumField label="Z, М" value={def.start.z} onChange={(v) => setDef({ start: { ...def.start, z: v } })} />
              <NumField
                label="КУРС, °"
                value={radToDeg(def.start.h)}
                step={5}
                min={-180}
                max={180}
                onChange={(v) => setDef({ start: { ...def.start, h: degToRad(v) } })}
              />
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {([
                ["↑ 0°", 0],
                ["→ −90°", -90],
                ["↓ 180°", 180],
                ["← +90°", 90],
              ] as const).map(([label, deg]) => (
                <button
                  key={label}
                  type="button"
                  className="btn btn-mini"
                  onClick={() => setDef({ start: { ...def.start, h: degToRad(deg) } })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-xs font-extrabold">
                Парковочные места ({def.bays.filter((b) => !b.occupied).length} свободных из {def.bays.length})
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => {
                    const id = nextBayId(def);
                    onChange({
                      ...def,
                      bays: [
                        ...def.bays,
                        {
                          id,
                          label: `Бокс №${id} (свой)`,
                          kind: "perpendicular",
                          cx: 0,
                          cz: 0,
                          width: 2.5,
                          length: 5.3,
                          h: 0,
                          openSide: "front",
                          occupied: false,
                          requireReverseEntry: true,
                        },
                      ],
                    });
                  }}
                >
                  + Бокс 90°
                </button>
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => {
                    const id = nextBayId(def);
                    onChange({
                      ...def,
                      bays: [
                        ...def.bays,
                        {
                          id,
                          label: `Карман №${id} (свой)`,
                          kind: "parallel",
                          cx: 0,
                          cz: 6,
                          width: 2.2,
                          length: 6.0,
                          h: 0,
                          openSide: "left",
                          occupied: false,
                          requireReverseEntry: true,
                        },
                      ],
                    });
                  }}
                >
                  + Карман
                </button>
              </div>
            </div>
            {def.bays.length === 0 && (
              <div className="text-[12px] text-[#7c909d]">Мест пока нет — добавьте бокс или карман.</div>
            )}
            <div className="space-y-2.5">
              {def.bays.map((bay, i) => (
                <div key={bay.id} className="panel-soft p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="mono text-[11px] text-[#f5b942] font-bold">№{bay.id}</span>
                    <select
                      value={bay.kind}
                      onChange={(e) => {
                        const bays = def.bays.map((b, k) =>
                          k === i ? { ...b, kind: e.target.value as ParkingBayKind } : b
                        );
                        onChange({ ...def, bays });
                      }}
                      className="rounded bg-[#091017] border hairline px-1.5 py-1 text-[11px] text-white"
                    >
                      {BAY_KINDS.map((k) => (
                        <option key={k.v} value={k.v}>
                          {k.l}
                        </option>
                      ))}
                    </select>
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[#9bafbc] ml-auto cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bay.occupied}
                        onChange={(e) => {
                          const bays = def.bays.map((b, k) =>
                            k === i ? { ...b, occupied: e.target.checked } : b
                          );
                          onChange({ ...def, bays });
                        }}
                      />
                      Занят
                    </label>
                    <button
                      type="button"
                      className="mono text-[11px] text-[#ff9494] hover:underline"
                      onClick={() => onChange({ ...def, bays: def.bays.filter((_, k) => k !== i) })}
                    >
                      Удалить
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <NumField label="ЦЕНТР X" value={bay.cx} onChange={(v) => {
                      const bays = def.bays.map((b, k) => (k === i ? { ...b, cx: v } : b));
                      onChange({ ...def, bays });
                    }} />
                    <NumField label="ЦЕНТР Z" value={bay.cz} onChange={(v) => {
                      const bays = def.bays.map((b, k) => (k === i ? { ...b, cz: v } : b));
                      onChange({ ...def, bays });
                    }} />
                    <NumField label="ПОВОРОТ, °" value={radToDeg(bay.h)} step={5} min={-180} max={180} onChange={(v) => {
                      const bays = def.bays.map((b, k) => (k === i ? { ...b, h: degToRad(v) } : b));
                      onChange({ ...def, bays });
                    }} />
                    <NumField label="ШИРИНА, М" value={bay.width} step={0.1} min={1.9} max={8} onChange={(v) => {
                      const bays = def.bays.map((b, k) => (k === i ? { ...b, width: v } : b));
                      onChange({ ...def, bays });
                    }} />
                    <NumField label="ДЛИНА, М" value={bay.length} step={0.1} min={4.4} max={12} onChange={(v) => {
                      const bays = def.bays.map((b, k) => (k === i ? { ...b, length: v } : b));
                      onChange({ ...def, bays });
                    }} />
                    <label className="block min-w-0">
                      <span className="mono text-[10px] text-[#7c909d] block mb-1">МОДЕЛЬ АВТО</span>
                      <select
                        value={bay.parkedModel ?? "rio"}
                        disabled={!bay.occupied}
                        onChange={(e) => {
                          const bays = def.bays.map((b, k) =>
                            k === i ? { ...b, parkedModel: e.target.value as ParkedModelKey } : b
                          );
                          onChange({ ...def, bays });
                        }}
                        className="w-full rounded bg-[#091017] border hairline px-1.5 py-1.5 text-[11px] text-white disabled:opacity-40"
                      >
                        {PARKED_MODELS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-xs font-extrabold">Препятствия ({def.obstacles.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {([
                  ["+ Бордюр", "curb"],
                  ["+ Конус", "cone"],
                  ["+ Здание", "building"],
                  ["+ Машина", "parked_car"],
                ] as const).map(([label, kind]) => (
                  <button
                    key={kind}
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      const preset =
                        kind === "curb"
                          ? { halfX: 3, halfZ: 0.18, height: 0.16 }
                          : kind === "cone"
                            ? { halfX: 0.14, halfZ: 0.14, height: 0.55 }
                            : kind === "building"
                              ? { halfX: 5, halfZ: 5, height: 10 }
                              : { halfX: 0.9, halfZ: 2.2, height: 1.47 };
                      onChange({
                        ...def,
                        obstacles: [
                          ...def.obstacles,
                          {
                            id: nextObstacleId(def, kind),
                            kind,
                            cx: 4,
                            cz: 4,
                            ...preset,
                            h: 0,
                            color: kind === "cone" ? 0xf97316 : kind === "building" ? 0x52616f : 0x9aa6b2,
                            model: kind === "parked_car" ? "ceed" : undefined,
                            label: kind === "cone" ? "разметочный конус" : undefined,
                          },
                        ],
                      });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {def.obstacles.length === 0 && (
              <div className="text-[12px] text-[#7c909d]">Препятствий пока нет.</div>
            )}
            <div className="space-y-2.5">
              {def.obstacles.map((o, i) => (
                <div key={o.id} className="panel-soft p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <select
                      value={o.kind}
                      onChange={(e) => {
                        const obstacles = def.obstacles.map((x, k) =>
                          k === i ? { ...x, kind: e.target.value as ObstacleKind } : x
                        );
                        onChange({ ...def, obstacles });
                      }}
                      className="rounded bg-[#091017] border hairline px-1.5 py-1 text-[11px] text-white"
                    >
                      {OBSTACLE_KINDS.map((k) => (
                        <option key={k.v} value={k.v}>
                          {k.l}
                        </option>
                      ))}
                    </select>
                    <span className="mono text-[10px] text-[#6e8492] truncate">{o.id}</span>
                    <button
                      type="button"
                      className="mono text-[11px] text-[#ff9494] hover:underline ml-auto"
                      onClick={() => onChange({ ...def, obstacles: def.obstacles.filter((_, k) => k !== i) })}
                    >
                      Удалить
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <NumField label="ЦЕНТР X" value={o.cx} onChange={(v) => {
                      const obstacles = def.obstacles.map((x, k) => (k === i ? { ...x, cx: v } : x));
                      onChange({ ...def, obstacles });
                    }} />
                    <NumField label="ЦЕНТР Z" value={o.cz} onChange={(v) => {
                      const obstacles = def.obstacles.map((x, k) => (k === i ? { ...x, cz: v } : x));
                      onChange({ ...def, obstacles });
                    }} />
                    <NumField label="ПОВОРОТ, °" value={radToDeg(o.h)} step={5} min={-180} max={180} onChange={(v) => {
                      const obstacles = def.obstacles.map((x, k) => (k === i ? { ...x, h: degToRad(v) } : x));
                      onChange({ ...def, obstacles });
                    }} />
                    <NumField label="ПОЛУШИРИНА X" value={o.halfX} step={0.1} min={0.05} max={60} onChange={(v) => {
                      const obstacles = def.obstacles.map((x, k) => (k === i ? { ...x, halfX: v } : x));
                      onChange({ ...def, obstacles });
                    }} />
                    <NumField label="ПОЛУДЛИНА Z" value={o.halfZ} step={0.1} min={0.05} max={60} onChange={(v) => {
                      const obstacles = def.obstacles.map((x, k) => (k === i ? { ...x, halfZ: v } : x));
                      onChange({ ...def, obstacles });
                    }} />
                    <NumField label="ВЫСОТА, М" value={o.height} step={0.5} min={0.1} max={40} onChange={(v) => {
                      const obstacles = def.obstacles.map((x, k) => (k === i ? { ...x, height: v } : x));
                      onChange({ ...def, obstacles });
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-xs font-extrabold">Точки маршрута ({def.checkpoints.length})</div>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() =>
                  onChange({
                    ...def,
                    checkpoints: [
                      ...def.checkpoints,
                      {
                        id: nextCheckpointId(def),
                        x: 0,
                        z: 10,
                        radius: 5,
                        instruction: "Двигайтесь к следующей точке.",
                      },
                    ],
                  })
                }
              >
                + Точка
              </button>
            </div>
            <div className="text-[11px] text-[#7c909d] mb-3">
              Если точек нет — это упражнение на парковку. Если есть — маршрутный заезд со стартом в D.
            </div>
            <div className="space-y-2.5">
              {def.checkpoints.map((cp, i) => (
                <div key={cp.id} className="panel-soft p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="mono text-[11px] text-[#52d6bd] font-bold">
                      {i + 1}. {cp.id}
                    </span>
                    <button
                      type="button"
                      className="mono text-[11px] text-[#ff9494] hover:underline ml-auto"
                      onClick={() =>
                        onChange({ ...def, checkpoints: def.checkpoints.filter((_, k) => k !== i) })
                      }
                    >
                      Удалить
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5 mb-2.5">
                    <NumField label="X" value={cp.x} onChange={(v) => {
                      const checkpoints = def.checkpoints.map((c, k) => (k === i ? { ...c, x: v } : c));
                      onChange({ ...def, checkpoints });
                    }} />
                    <NumField label="Z" value={cp.z} onChange={(v) => {
                      const checkpoints = def.checkpoints.map((c, k) => (k === i ? { ...c, z: v } : c));
                      onChange({ ...def, checkpoints });
                    }} />
                    <NumField label="РАДИУС" value={cp.radius} step={0.5} min={1} max={15} onChange={(v) => {
                      const checkpoints = def.checkpoints.map((c, k) => (k === i ? { ...c, radius: v } : c));
                      onChange({ ...def, checkpoints });
                    }} />
                  </div>
                  <TextField label="ЗАДАНИЕ ЭКЗАМЕНАТОРА" value={cp.instruction} onChange={(v) => {
                    const checkpoints = def.checkpoints.map((c, k) => (k === i ? { ...c, instruction: v } : c));
                    onChange({ ...def, checkpoints });
                  }} />
                  <div className="flex flex-wrap items-center gap-3 mt-2.5">
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[#9bafbc]">
                      Поворотник:
                      <select
                        value={cp.requireSignal ?? ""}
                        onChange={(e) => {
                          const v = e.target.value as "" | "left" | "right";
                          const checkpoints = def.checkpoints.map((c, k) =>
                            k === i ? { ...c, requireSignal: v === "" ? undefined : v } : c
                          );
                          onChange({ ...def, checkpoints });
                        }}
                        className="rounded bg-[#091017] border hairline px-1.5 py-1 text-[11px] text-white"
                      >
                        <option value="">не требуется</option>
                        <option value="left">левый (Q)</option>
                        <option value="right">правый (E)</option>
                      </select>
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[#9bafbc] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(cp.isFinalPark)}
                        onChange={(e) => {
                          const checkpoints = def.checkpoints.map((c, k) =>
                            k === i ? { ...c, isFinalPark: e.target.checked || undefined } : c
                          );
                          onChange({ ...def, checkpoints });
                        }}
                      />
                      Финиш — парковка
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* [SEC:custom-preview] Правая колонка: 2D-схема площадки и проверка коллизий */}
        <div className="panel p-4 lg:sticky lg:top-[72px]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-extrabold">Схема (клик — переместить старт)</div>
            <Chip tone="neutral">+Z ↑ · +X ←</Chip>
          </div>
          <div className="rounded-xl bg-[#091017] border hairline overflow-hidden">
            <svg
              viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
              onClick={handlePreviewClick}
              className="w-full h-[380px] cursor-crosshair"
              role="img"
              aria-label="Схема своего сценария"
            >
              {/* Площадка и границы */}
              <rect
                x={-def.lotHalfX}
                y={-def.lotHalfZ}
                width={def.lotHalfX * 2}
                height={def.lotHalfZ * 2}
                fill="#1f2a35"
                stroke="#3b4a5a"
                strokeWidth={0.2}
              />
              <rect
                x={-def.bounds.maxX}
                y={-def.bounds.maxZ}
                width={def.bounds.maxX - def.bounds.minX}
                height={def.bounds.maxZ - def.bounds.minZ}
                fill="none"
                stroke="#f5b942"
                strokeOpacity={0.4}
                strokeDasharray="1.2 0.8"
                strokeWidth={0.15}
              />
              {/* Боксы */}
              {def.bays.map((b) => (
                <g
                  key={b.id}
                  transform={`translate(${-b.cx} ${-b.cz}) rotate(${(-b.h * 180) / Math.PI})`}
                >
                  <rect
                    x={-b.width / 2}
                    y={-b.length / 2}
                    width={b.width}
                    height={b.length}
                    fill={b.occupied ? "rgba(100,116,139,0.3)" : "rgba(245,185,66,0.12)"}
                    stroke={b.occupied ? "#64748b" : "#e2e8f0"}
                    strokeWidth={0.12}
                  />
                  <text
                    x={0}
                    y={0.35}
                    textAnchor="middle"
                    fontSize={0.9}
                    fill={b.occupied ? "#94a3b8" : "#f5b942"}
                    transform="scale(-1,-1)"
                  >
                    {b.id}
                  </text>
                </g>
              ))}
              {/* Препятствия */}
              {def.obstacles.map((o) => (
                <g
                  key={o.id}
                  transform={`translate(${-o.cx} ${-o.cz}) rotate(${(-o.h * 180) / Math.PI})`}
                >
                  <rect
                    x={-o.halfX}
                    y={-o.halfZ}
                    width={o.halfX * 2}
                    height={o.halfZ * 2}
                    fill={
                      o.kind === "parked_car"
                        ? "#3b82f6"
                        : o.kind === "building"
                          ? "#334155"
                          : o.kind === "cone"
                            ? "#f97316"
                            : "#94a3b8"
                    }
                    opacity={0.85}
                  />
                </g>
              ))}
              {/* Точки маршрута */}
              {def.checkpoints.map((cp, i) => (
                <g key={cp.id}>
                  <circle
                    cx={-cp.x}
                    cy={-cp.z}
                    r={cp.radius}
                    fill="none"
                    stroke="#52d6bd"
                    strokeWidth={0.18}
                    strokeDasharray="0.7 0.5"
                  />
                  <text x={-cp.x} y={-cp.z + 0.45} textAnchor="middle" fontSize={1.1} fill="#52d6bd">
                    {i + 1}
                  </text>
                </g>
              ))}
              {/* Старт */}
              <line
                x1={-def.start.x}
                y1={-def.start.z}
                x2={startTipX}
                y2={startTipY}
                stroke="#f5b942"
                strokeWidth={0.3}
              />
              <circle cx={-def.start.x} cy={-def.start.z} r={0.55} fill="#f5b942" />
              <circle cx={startTipX} cy={startTipY} r={0.3} fill="#f5b942" />
            </svg>
          </div>
          <div className="flex flex-wrap gap-3 mt-2.5 mono text-[10px] text-[#8fa2ae]">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-[#f5b942]" />
              старт
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm border border-[#e2e8f0]" />
              свободный бокс
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-[#64748b]" />
              занят / здание
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full border border-[#52d6bd]" />
              точка маршрута
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
