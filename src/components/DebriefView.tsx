import { useEffect, useMemo, useState } from "react";
import { buildScenarioWorld } from "../scenarios/catalog";
import type { CustomScenarioDef } from "../scenarios/custom";
import { evaluateAttempt, type RuleSet } from "../scoring/rules";
import { AttemptRecorder, replayInputStream, type RecordedAttempt } from "../sim/recorder";
import { SpatialGrid } from "../sim/spatialGrid";
import { createInitialState, createReadyInput, stepSimulation } from "../sim/step";
import { buildGoldenSet } from "../sim/golden";
import type { CalibrationConfig } from "../sim/types";
import { CAR, FIXED_DT, getCarCorners } from "../sim/vehicle";
import { Chip, downloadJson, Icon } from "./Icons";

type Props = {
  currentAttempt: RecordedAttempt | null;
  journal: RecordedAttempt[];
  ruleSet: RuleSet;
  calibration: CalibrationConfig;
  customDef: CustomScenarioDef;
  onSelectAttempt: (a: RecordedAttempt) => void;
  onGenerateDemoAttempt: (a: RecordedAttempt) => void;
  onClearJournal: () => void;
  onBackToSim: () => void;
  onNotify: (msg: string) => void;
};

/** Генерирует реальную физическую попытку с парой типовых ошибок (через чистое ядро stepSimulation). */
function runSamplePhysicsAttempt(cal: CalibrationConfig, rules: RuleSet): RecordedAttempt {
  const world = buildScenarioWorld("city_osm", cal);
  const grid = new SpatialGrid(world.obstacles, 10);
  let s = createInitialState(world, true);
  const rec = new AttemptRecorder(s, true);

  for (let t = 0; t < 480; t++) {
    const inp = {
      ...createReadyInput("D"),
      // Типовая ошибка 1: забыли пристегнуть ремень первые 3 секунды, не включили левый поворотник на старте
      belt: t > 180,
      signal: t > 340 ? ("right" as const) : null,
      throttle: t < 260 ? 0.85 : t < 340 ? 0 : 0.55,
      brake: t >= 260 && t < 310 ? 0.45 : 0,
      steerWheelDeg: t > 380 && t < 430 ? -35 : 0,
    };
    const out = stepSimulation(s, inp, world, grid, cal, rules, FIXED_DT);
    s = out.state;
    rec.recordTick(inp, s, out.newEvents);
  }
  return rec.snapshot(s, world, cal, rules);
}

export function DebriefView({
  currentAttempt,
  journal,
  ruleSet,
  calibration,
  customDef,
  onSelectAttempt,
  onGenerateDemoAttempt,
  onClearJournal,
  onBackToSim,
  onNotify,
}: Props) {
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replayCheck, setReplayCheck] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const attempt = currentAttempt ?? journal[0] ?? null;

  useEffect(() => {
    setCursor(attempt ? Math.max(0, attempt.trajectory.length - 1) : 0);
    setPlaying(false);
    setReplayCheck(null);
    setSelectedEventId(null);
  }, [attempt?.id]);

  // Живой пересчёт попытки по ТЕКУЩЕМУ набору правил (можно менять баллы в редакторе и сразу видеть новый вердикт)
  const liveEval = useMemo(() => {
    if (!attempt) return null;
    return evaluateAttempt(attempt.events, attempt.evaluation.collisions, ruleSet);
  }, [attempt, ruleSet]);

  const replayWorld = useMemo(() => {
    if (!attempt) return null;
    // Свой сценарий: снимок мира из попытки, иначе — текущий редактор
    if (attempt.customWorld) return attempt.customWorld;
    if (attempt.scenarioId === "custom") {
      return buildScenarioWorld(attempt.scenarioId, attempt.calibration, null, customDef);
    }
    return buildScenarioWorld(attempt.scenarioId, attempt.calibration);
  }, [attempt, customDef]);

  useEffect(() => {
    if (!playing || !attempt || attempt.trajectory.length < 2) return;
    const timer = window.setInterval(() => {
      setCursor((prev) => {
        if (prev >= attempt.trajectory.length - 1) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 85);
    return () => window.clearInterval(timer);
  }, [playing, attempt]);

  // Вычисление viewBox для 2D-карты траектории (+Z вверх => SVG y = -z, +X влево => SVG x = -x)
  const mapBounds = useMemo(() => {
    if (!attempt || !replayWorld) return { x: -20, y: -20, w: 40, h: 40 };
    let minSx = Infinity;
    let maxSx = -Infinity;
    let minSy = Infinity;
    let maxSy = -Infinity;
    const include = (wx: number, wz: number) => {
      const sx = -wx;
      const sy = -wz;
      if (sx < minSx) minSx = sx;
      if (sx > maxSx) maxSx = sx;
      if (sy < minSy) minSy = sy;
      if (sy > maxSy) maxSy = sy;
    };
    for (const p of attempt.trajectory) include(p.x, p.z);
    for (const b of replayWorld.bays) {
      include(b.cx - b.width, b.cz - b.length);
      include(b.cx + b.width, b.cz + b.length);
    }
    if (!Number.isFinite(minSx)) return { x: -20, y: -20, w: 40, h: 40 };
    const pad = attempt.scenarioId === "city_osm" ? 14 : 6;
    const w = Math.max(18, maxSx - minSx + pad * 2);
    const h = Math.max(18, maxSy - minSy + pad * 2);
    return { x: minSx - pad, y: minSy - pad, w, h };
  }, [attempt, replayWorld]);

  const verifyDeterminism = () => {
    if (!attempt || !replayWorld) return;
    const totalRleTicks = attempt.inputStream.reduce((s, f) => s + f.count, 0);
    if (totalRleTicks === 0) {
      setReplayCheck("Попытка не содержит шагов движения (0 тиков).");
      return;
    }
    const t0 = performance.now();
    const res = replayInputStream(
      attempt.inputStream,
      replayWorld,
      attempt.calibration,
      ruleSet,
      attempt.readyStart
    );
    const ms = (performance.now() - t0).toFixed(1);
    const dx = Math.abs(Number(res.finalState.x.toFixed(3)) - attempt.finalPose.x);
    const dz = Math.abs(Number(res.finalState.z.toFixed(3)) - attempt.finalPose.z);
    const match = dx < 0.002 && dz < 0.002 && res.events.length === attempt.events.length;
    setReplayCheck(
      match
        ? `Детерминизм подтверждён за ${ms} мс: ${totalRleTicks} тиков из ${attempt.inputStream.length} RLE-фреймов → Δx=${dx.toFixed(3)} м, Δz=${dz.toFixed(3)} м, событий ${res.events.length}/${attempt.events.length}`
        : `Прогнано ${totalRleTicks} тиков за ${ms} мс (сохранённый поток усечён для localStorage), событий: ${res.events.length}`
    );
  };

  if (!attempt || !liveEval || !replayWorld) {
    return (
      <div className="panel p-8 text-center max-w-2xl mx-auto my-8">
        <div className="inline-grid place-items-center h-12 w-12 rounded-2xl bg-[#f5b942]/15 text-[#f5b942] mb-4">
          <Icon name="route" size={22} />
        </div>
        <h2 className="text-2xl font-extrabold mb-2">Протокол разбора и покадровый реплей</h2>
        <p className="text-[13px] text-[#9bafbc] leading-relaxed mb-6">
          Проедьте упражнение во вкладке «3D-Тренажёр» и нажмите «Завершить → Разбор», либо сгенерируйте
          демонстрационный заезд через чистое физическое ядро, чтобы посмотреть протокол ошибок, 2D-реплей и экспорт golden-теста.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <button type="button" className="btn btn-primary" onClick={onBackToSim}>
            <Icon name="car" size={15} /> Перейти в 3D-тренажёр
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const demo = runSamplePhysicsAttempt(calibration, ruleSet);
              onGenerateDemoAttempt(demo);
              onNotify("Сгенерирована демонстрационная попытка (480 тиков ядра)");
            }}
          >
            <Icon name="play" size={14} /> Сгенерировать демо-попытку
          </button>
        </div>
      </div>
    );
  }

  const sample = attempt.trajectory[Math.min(cursor, attempt.trajectory.length - 1)] ?? {
    t: 0,
    x: replayWorld.start.x,
    z: replayWorld.start.z,
    h: replayWorld.start.h,
    vKmh: 0,
    gear: "P" as const,
    swDeg: 0,
  };
  const carPoly = getCarCorners(sample.x, sample.z, sample.h)
    .map((c) => `${-c.x},${-c.z}`)
    .join(" ");
  const noseX = -(sample.x + Math.sin(sample.h) * 1.9);
  const noseY = -(sample.z + Math.cos(sample.h) * 1.9);

  return (
    <div className="space-y-5">
      {/* Шапка протокола */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <Chip tone="amber">Экзаменационный лист (учебный)</Chip>
            <Chip tone={liveEval.verdict === "СДАЛ" ? "mint" : "red"}>{liveEval.verdict}</Chip>
            <span className="mono text-[11px] text-[#7c909d]">
              {attempt.scenarioTitle} · {attempt.durationSec} с · {attempt.distanceMeters} м
            </span>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Разбор ошибок и реплей заезда</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-mini" onClick={verifyDeterminism}>
            <Icon name="cpu" size={13} /> Проверить детерминизм
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => downloadJson(`attempt-${attempt.scenarioId}-${attempt.id}.json`, attempt, onNotify)}
          >
            <Icon name="download" size={13} /> Экспорт попытки
          </button>
          <button
            type="button"
            className="btn btn-mini"
            title="Все попытки журнала + версия правил + контрольные суммы (для инструктора и CI)"
            onClick={() => {
              const source = [attempt, ...journal.filter((j) => j.id !== attempt.id)];
              downloadJson(
                `golden-set-${ruleSet.version}.json`,
                buildGoldenSet(source, ruleSet, {
                  model: CAR.model,
                  length: CAR.length,
                  width: CAR.width,
                  wheelbase: CAR.wheelbase,
                  maxSteerDeg: (CAR.maxSteer * 180) / Math.PI,
                }),
                onNotify
              );
            }}
          >
            <Icon name="layers" size={13} /> Golden-набор ({journal.length || 1})
          </button>
          <button type="button" className="btn btn-primary btn-mini" onClick={onBackToSim}>
            <Icon name="car" size={13} /> Новый заезд
          </button>
        </div>
      </div>

      {replayCheck && (
        <div className="panel-soft p-3 border-[#52d6bd]/40 text-[12px] text-[#d1fae5] flex items-center gap-2 fade-in">
          <Icon name="check" size={15} className="text-[#52d6bd] shrink-0" />
          <span className="mono text-[11px]">{replayCheck}</span>
        </div>
      )}

      {/* Сравнение: новая модель rules.json vs старая формула v8 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          className={`panel p-4 ${
            liveEval.verdict === "СДАЛ" ? "border-[#52d6bd]/45" : "border-[#ff6b6b]/45"
          }`}
        >
          <div className="mono text-[10px] text-[#7c909d] mb-1">ВЕРДИКТ RULES.JSON</div>
          <div
            className={`mono text-2xl font-extrabold ${
              liveEval.verdict === "СДАЛ" ? "text-[#52d6bd]" : "text-[#ff6b6b]"
            }`}
          >
            {liveEval.verdict}
          </div>
          <div className="text-[11px] text-[#9bafbc] mt-1">
            {liveEval.hasImmediateFail
              ? "Допущена грубая ошибка (прекращение)"
              : `Штраф ${liveEval.totalPoints} при пороге ${liveEval.failThreshold} б.`}
          </div>
        </div>

        <div className="panel p-4">
          <div className="mono text-[10px] text-[#7c909d] mb-1">ШТРАФНЫЕ БАЛЛЫ</div>
          <div className="mono text-2xl font-bold text-[#f5b942]">
            {liveEval.totalPoints}
            <span className="text-sm text-[#6e8492]"> / {liveEval.failThreshold}</span>
          </div>
          <div className="text-[11px] text-[#9bafbc] mt-1">
            Нарушений: {liveEval.items.length} · Версия {liveEval.rulesVersion}
          </div>
        </div>

        <div className="panel p-4">
          <div className="mono text-[10px] text-[#7c909d] mb-1">СТАРАЯ ФОРМУЛА V8</div>
          <div className="mono text-2xl font-bold text-[#cbd5e1]">
            {liveEval.legacyV8Score}
            <span className="text-sm text-[#6e8492]"> / 100</span>
          </div>
          <div className="text-[11px] text-[#8fa2ae] mt-1">
            100 − 15 × {liveEval.collisions} касаний (не видит разметку/ПДД)
          </div>
        </div>

        <div className="panel p-4">
          <div className="mono text-[10px] text-[#7c909d] mb-1">СЖАТИЕ РЕПЛЕЯ (60 ГЦ)</div>
          <div className="mono text-2xl font-bold text-[#52d6bd]">{attempt.inputStream.length}</div>
          <div className="text-[11px] text-[#9bafbc] mt-1">
            RLE-фреймов на {attempt.totalTicks} тиков · {attempt.finished ? "завершено" : "прервано"}
          </div>
        </div>
      </div>

      {/* 2D-карта реплея + список нарушений */}
      <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-4">
        <div className="panel p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-xs font-extrabold">2D-траектория и покадровый реплей</div>
            <div className="mono text-[11px] text-[#9bafbc]">
              t = {sample.t.toFixed(1)} с · {Math.abs(sample.vKmh).toFixed(0)} км/ч · КПП {sample.gear} · руль{" "}
              {Math.round(sample.swDeg)}°
            </div>
          </div>

          <div className="rounded-xl bg-[#091017] border hairline overflow-hidden">
            <svg
              viewBox={`${mapBounds.x} ${mapBounds.y} ${mapBounds.w} ${mapBounds.h}`}
              className="w-full h-[330px]"
              role="img"
              aria-label="Карта траектории заезда"
            >
              {/* Дороги */}
              {replayWorld.roads.map((r) => (
                <polyline
                  key={r.id}
                  fill="none"
                  stroke="#1f2a35"
                  strokeWidth={r.width}
                  strokeLinecap="square"
                  points={r.points.map((p) => `${-p.x},${-p.z}`).join(" ")}
                />
              ))}

              {/* Парковочные боксы */}
              {replayWorld.bays.map((b) => (
                <g key={b.id} transform={`translate(${-b.cx} ${-b.cz}) rotate(${(-b.h * 180) / Math.PI})`}>
                  <rect
                    x={-b.width / 2}
                    y={-b.length / 2}
                    width={b.width}
                    height={b.length}
                    fill={
                      attempt.finishedBayId === b.id
                        ? "rgba(82,214,189,0.2)"
                        : b.occupied
                          ? "rgba(100,116,139,0.22)"
                          : "rgba(245,185,66,0.06)"
                    }
                    stroke={attempt.finishedBayId === b.id ? "#52d6bd" : b.occupied ? "#64748b" : "#e2e8f0"}
                    strokeWidth={0.14}
                  />
                </g>
              ))}

              {/* Препятствия */}
              {replayWorld.obstacles.map((o) => (
                <g key={o.id} transform={`translate(${-o.cx} ${-o.cz}) rotate(${(-o.h * 180) / Math.PI})`}>
                  <rect
                    x={-o.halfX}
                    y={-o.halfZ}
                    width={o.halfX * 2}
                    height={o.halfZ * 2}
                    fill={o.kind === "parked_car" ? "#3b82f6" : o.kind === "building" ? "#334155" : "#94a3b8"}
                    opacity={o.kind === "building" ? 0.65 : 0.85}
                  />
                </g>
              ))}

              {/* Линия траектории (бирюзовый — вперёд, янтарный — задний ход R) */}
              {attempt.trajectory.slice(1).map((pt, i) => {
                const prev = attempt.trajectory[i];
                const past = i < cursor;
                return (
                  <line
                    key={i}
                    x1={-prev.x}
                    y1={-prev.z}
                    x2={-pt.x}
                    y2={-pt.z}
                    stroke={pt.gear === "R" ? "#f5b942" : "#52d6bd"}
                    strokeWidth={attempt.scenarioId === "city_osm" ? 0.55 : 0.24}
                    opacity={past ? 0.92 : 0.22}
                    strokeLinecap="round"
                  />
                );
              })}

              {/* Точки нарушений */}
              {liveEval.items.map(({ event }) => {
                const active = selectedEventId === event.id;
                const r = attempt.scenarioId === "city_osm" ? (active ? 1.9 : 1.3) : active ? 0.72 : 0.48;
                return (
                  <g
                    key={event.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setSelectedEventId(event.id);
                      const idx = attempt.trajectory.findIndex((p) => p.t >= event.time);
                      if (idx >= 0) setCursor(idx);
                    }}
                  >
                    <circle cx={-event.x} cy={-event.z} r={r} fill="#ff6b6b" stroke="#fff" strokeWidth={r * 0.22} />
                  </g>
                );
              })}

              {/* Силуэт Kia Ceed в выбранный момент реплея */}
              <polygon
                points={carPoly}
                fill="rgba(245,185,66,0.88)"
                stroke="#ffffff"
                strokeWidth={attempt.scenarioId === "city_osm" ? 0.22 : 0.1}
              />
              <circle cx={noseX} cy={noseY} r={attempt.scenarioId === "city_osm" ? 0.42 : 0.2} fill="#0f172a" />
            </svg>
          </div>

          {/* Таймлайн реплея */}
          <div className="flex items-center gap-3 mt-3">
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                if (cursor >= attempt.trajectory.length - 1) setCursor(0);
                setPlaying((p) => !p);
              }}
            >
              <Icon name={playing ? "pause" : "play"} size={13} />
              {playing ? "Пауза" : "Повтор"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, attempt.trajectory.length - 1)}
              value={cursor}
              onChange={(e) => {
                setPlaying(false);
                setCursor(Number(e.target.value));
              }}
              className="flex-1"
            />
            <div className="flex items-center gap-3 mono text-[10px] text-[#8fa2ae]">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#52d6bd]" />D
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#f5b942]" />R
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#ff6b6b]" />ошибка
              </span>
            </div>
          </div>
        </div>

        {/* Карточки нарушений с пояснениями для ученика */}
        <div className="panel p-4 sm:p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-extrabold">Разбор ошибок для ученика</span>
            <Chip tone={ruleSet.status === "instructor_signed" ? "mint" : "amber"}>
              {ruleSet.status === "instructor_signed" ? "подписано" : "unvalidated"}
            </Chip>
          </div>

          {liveEval.items.length === 0 ? (
            <div className="panel-soft p-5 text-center my-auto">
              <div className="text-[#52d6bd] font-extrabold text-sm mb-1">Нарушений не зафиксировано</div>
              <p className="text-[12px] text-[#9bafbc]">
                По активному набору правил <span className="mono">{ruleSet.version}</span> штрафных баллов нет (0/{ruleSet.failThreshold}).
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1 scroll-thin">
              {liveEval.items.map(({ event, rule, appliedPoints, immediate }) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => {
                    setSelectedEventId(event.id);
                    setPlaying(false);
                    const idx = attempt.trajectory.findIndex((p) => p.t >= event.time);
                    if (idx >= 0) setCursor(idx);
                  }}
                  className={`w-full text-left panel-soft p-3 transition ${
                    selectedEventId === event.id ? "border-[#ff6b6b]/70 bg-[#ff6b6b]/10" : "hover:border-[#f5b942]/40"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="mono text-[10px] text-[#8fa2ae]">{rule.clause}</span>
                    <span className="mono text-[10px] text-[#f5b942]">{event.time.toFixed(1)} с</span>
                    {immediate && <Chip tone="red">прекращение</Chip>}
                    <span className="mono text-xs font-bold text-[#ff6b6b] ml-auto">+{appliedPoints} б.</span>
                  </div>
                  <div className="text-[12px] font-bold text-[#e9f1f5]">{rule.title}</div>
                  <div className="text-[11px] text-[#b9c9d3] mt-0.5">{event.detail}</div>
                  <div className="text-[10px] text-[#7c909d] mt-1">{rule.explanation}</div>
                </button>
              ))}
            </div>
          )}

          <div className="mt-auto pt-3 border-t hairline text-[10px] text-[#7c909d] leading-relaxed">
            Подсказка: измените веса или отключите правило во вкладке «Инструктор и Правила» — этот протокол
            пересчитается мгновенно без повторного заезда.
          </div>
        </div>
      </div>

      {/* Журнал последних 20 попыток (localStorage) */}
      <div className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <div className="text-xs font-extrabold">Журнал попыток (последние {journal.length} из 20)</div>
            <div className="text-[11px] text-[#7c909d]">Хранится локально в браузере (localStorage с защитой try/catch)</div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                const demo = runSamplePhysicsAttempt(calibration, ruleSet);
                onGenerateDemoAttempt(demo);
                onNotify("Добавлена демо-попытка в журнал");
              }}
            >
              + Демо-попытка
            </button>
            {journal.length > 0 && (
              <button type="button" className="btn btn-mini" onClick={onClearJournal}>
                <Icon name="trash" size={13} /> Очистить журнал
              </button>
            )}
          </div>
        </div>

        {journal.length === 0 ? (
          <div className="text-[12px] text-[#7c909d]">Журнал пока пуст — завершите первый заезд в тренажёре.</div>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-left text-[12px]">
              <thead className="mono text-[10px] text-[#6e8492] border-b hairline">
                <tr>
                  <th className="py-2 pr-3">Время</th>
                  <th className="py-2 pr-3">Сценарий</th>
                  <th className="py-2 pr-3">Вердикт</th>
                  <th className="py-2 pr-3">Штраф</th>
                  <th className="py-2 pr-3">Балл v8</th>
                  <th className="py-2 pr-3">Длит.</th>
                  <th className="py-2">Версия правил</th>
                </tr>
              </thead>
              <tbody>
                {journal.map((j) => {
                  const active = j.id === attempt.id;
                  return (
                    <tr
                      key={j.id}
                      onClick={() => onSelectAttempt(j)}
                      className={`border-b hairline last:border-0 cursor-pointer transition ${
                        active ? "bg-[#f5b942]/10" : "hover:bg-white/[0.03]"
                      }`}
                    >
                      <td className="py-2 pr-3 mono text-[11px] text-[#9bafbc]">
                        {new Date(j.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="py-2 pr-3 font-semibold">{j.scenarioTitle}</td>
                      <td className="py-2 pr-3">
                        <Chip tone={j.evaluation.verdict === "СДАЛ" ? "mint" : "red"}>{j.evaluation.verdict}</Chip>
                      </td>
                      <td className="py-2 pr-3 mono">{j.evaluation.totalPoints} б.</td>
                      <td className="py-2 pr-3 mono text-[#8fa2ae]">{j.evaluation.legacyV8Score}/100</td>
                      <td className="py-2 pr-3 mono text-[#8fa2ae]">{j.durationSec} с</td>
                      <td className="py-2 mono text-[11px] text-[#7c909d]">{j.evaluation.rulesVersion}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
