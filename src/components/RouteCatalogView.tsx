/**
 * @module components/RouteCatalogView
 * @layer ui
 * @role Интерактивное создание и управление каталогом экзаменационных маршрутов по импортированной OSM-карте.
 * @tests T32–T33 (ядро маршрутизации), Browser Smoke P.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { CustomScenarioDef } from "../scenarios/custom";
import {
  buildExamRouteRecord,
  fingerprintOsmScenario,
  isExamRouteRecord,
  type ExamRouteRecord,
} from "../maps/routeCatalog";
import { deleteRouteRecord, loadRouteCatalog, saveRouteRecord } from "../storage/routeCatalogStore";
import { downloadJson, Icon } from "./Icons";
import type { Vec2 } from "../sim/types";

type Props = {
  sourceDef: CustomScenarioDef;
  onOpenRoute: (scenario: CustomScenarioDef) => void;
  onNotify: (message: string) => void;
};

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

function mapBounds(source: CustomScenarioDef): Bounds | null {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let count = 0;
  for (const road of source.roads ?? []) {
    for (const point of road.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
      count += 1;
    }
  }
  if (count < 2) return null;
  const pad = Math.max(18, Math.max(maxX - minX, maxZ - minZ) * 0.06);
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
}

function routeCatalogEnvelope(routes: ExamRouteRecord[]) {
  return { schema: "cdt.routes.v1", exportedAt: new Date().toISOString(), routes };
}

export function RouteCatalogView({ sourceDef, onOpenRoute, onNotify }: Props) {
  const [routes, setRoutes] = useState<ExamRouteRecord[]>([]);
  const [backend, setBackend] = useState<"indexeddb" | "memory">("indexeddb");
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState<"start" | "finish">("start");
  const [startPoint, setStartPoint] = useState<Vec2 | null>(null);
  const [finishPoint, setFinishPoint] = useState<Vec2 | null>(null);
  const [title, setTitle] = useState("");
  const [spacing, setSpacing] = useState(90);
  const [preview, setPreview] = useState<ReturnType<typeof buildExamRouteRecord> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const bounds = useMemo(() => mapBounds(sourceDef), [sourceDef]);
  const fingerprint = useMemo(
    () => sourceDef.mapMeta ? fingerprintOsmScenario(sourceDef) : "",
    [sourceDef]
  );
  const hasOsm = Boolean(sourceDef.mapMeta && (sourceDef.roads?.length ?? 0) > 0);

  useEffect(() => {
    let alive = true;
    loadRouteCatalog().then((result) => {
      if (!alive) return;
      setRoutes(result.records);
      setBackend(result.backend);
      setWarning(result.warning);
      setLoading(false);
    }).catch((error) => {
      if (!alive) return;
      setWarning(error instanceof Error ? error.message : "Не удалось прочитать каталог");
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const handleMapClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!bounds) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = bounds.minX + ((event.clientX - rect.left) / rect.width) * (bounds.maxX - bounds.minX);
    const svgY = -bounds.maxZ + ((event.clientY - rect.top) / rect.height) * (bounds.maxZ - bounds.minZ);
    const point = { x: Number(x.toFixed(2)), z: Number((-svgY).toFixed(2)) };
    if (selectionMode === "start") {
      setStartPoint(point);
      setFinishPoint(null);
      setSelectionMode("finish");
    } else {
      setFinishPoint(point);
    }
    setPreview(null);
  };

  const handleBuild = () => {
    if (!startPoint || !finishPoint) {
      onNotify("Выберите на карте начало и конец маршрута");
      return;
    }
    const nextTitle = title.trim() || `Маршрут ${routes.length + 1}`;
    const id = `route-${Date.now().toString(36)}`;
    const result = buildExamRouteRecord(
      sourceDef,
      startPoint,
      finishPoint,
      nextTitle,
      id,
      new Date().toISOString(),
      spacing
    );
    setPreview(result);
    if (result.ok) setTitle(result.record.title);
  };

  const handleSave = async () => {
    if (!preview?.ok) return;
    try {
      const result = await saveRouteRecord(preview.record);
      setRoutes((current) => [preview.record, ...current.filter((route) => route.id !== preview.record.id)]);
      setBackend(result);
      setWarning(result === "memory" ? "IndexedDB недоступна: записи останутся только до закрытия вкладки." : null);
      onNotify(result === "indexeddb" ? "Маршрут сохранён в локальный каталог" : "Маршрут сохранён временно в памяти");
      setPreview(null);
      setStartPoint(null);
      setFinishPoint(null);
      setSelectionMode("start");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Не удалось сохранить маршрут");
    }
  };

  const handleDelete = async (route: ExamRouteRecord) => {
    if (!window.confirm(`Удалить маршрут «${route.title}» из каталога?`)) return;
    await deleteRouteRecord(route.id);
    setRoutes((current) => current.filter((item) => item.id !== route.id));
    onNotify(`Маршрут «${route.title}» удалён`);
  };

  const handleImport = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const candidate = parsed && typeof parsed === "object" && "routes" in parsed
        ? (parsed as { routes?: unknown }).routes
        : [parsed];
      if (!Array.isArray(candidate)) throw new Error("В файле нет массива маршрутов.");
      const valid = candidate.filter(isExamRouteRecord);
      if (valid.length === 0) throw new Error("Не найдено корректных записей cdt.route.v1.");
      for (const route of valid) await saveRouteRecord(route);
      const result = await loadRouteCatalog();
      setRoutes(result.records);
      setBackend(result.backend);
      setWarning(result.warning);
      onNotify(`Импортировано маршрутов: ${valid.length}`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Не удалось импортировать каталог");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const displayPath = preview?.ok ? preview.record.path : [];
  const viewWidth = bounds ? bounds.maxX - bounds.minX : 1;
  const viewHeight = bounds ? bounds.maxZ - bounds.minZ : 1;
  const currentMapMismatch = (route: ExamRouteRecord) => Boolean(fingerprint && route.mapFingerprint !== fingerprint);

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <ChipFallback>OSM ROUTE CATALOG</ChipFallback>
              <span className="text-[10px] mono text-[#8fa2ae]">OFFLINE · ODbL 1.0</span>
            </div>
            <h2 className="text-2xl font-extrabold tracking-tight">Каталог экзаменационных маршрутов</h2>
            <p className="text-sm text-[#9bafbc] mt-1 max-w-3xl">
              Маршруты строятся по дорожному графу импортированной карты. Для каждого сохраняется отдельный снимок карты, контрольные точки и стартовая поза.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-mini" onClick={() => downloadJson("cdt-routes.v1.json", routeCatalogEnvelope(routes), onNotify)} disabled={routes.length === 0}>
              <Icon name="download" size={13} /> Экспорт каталога
            </button>
            <button type="button" className="btn btn-mini" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={13} /> Импорт JSON
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImport(file);
            }} />
          </div>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-5">
          <div className="panel-soft p-3"><div className="text-[10px] mono text-[#8fa2ae]">В КАТАЛОГЕ</div><div className="text-2xl font-extrabold mt-1">{routes.length}</div></div>
          <div className="panel-soft p-3"><div className="text-[10px] mono text-[#8fa2ae]">ХРАНЕНИЕ</div><div className="text-sm font-bold mt-2">{backend === "indexeddb" ? "IndexedDB" : "Память вкладки"}</div></div>
          <div className="panel-soft p-3"><div className="text-[10px] mono text-[#8fa2ae]">КАРТА ДЛЯ СОЗДАНИЯ</div><div className="text-sm font-bold mt-2 truncate">{sourceDef.mapMeta?.title ?? "Не импортирована"}</div></div>
        </div>
        {warning && <div className="mt-3 text-xs text-[#f5b942]">{warning}</div>}
      </section>

      <section className="panel p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-extrabold">Создать маршрут по OSM</h3>
            <p className="text-xs text-[#8fa2ae] mt-1">Сначала выберите начало, затем конец. Точки будут привязаны к ближайшим дорогам.</p>
          </div>
          {hasOsm && <ChipFallback>{sourceDef.roads?.length ?? 0} дорожных сегментов</ChipFallback>}
        </div>

        {!hasOsm || !bounds ? (
          <div className="panel-soft p-5 text-sm text-[#b9c9d3]">
            <div className="font-bold mb-1">Сначала загрузите карту</div>
            Импортируйте локальный файл .osm XML, Overpass JSON или GeoJSON во вкладке «Свой сценарий». Затем вернитесь сюда — карта появится в редакторе маршрутов.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={`btn btn-mini ${selectionMode === "start" ? "btn-primary" : ""}`} onClick={() => setSelectionMode("start")}>1 · Начало</button>
              <button type="button" className={`btn btn-mini ${selectionMode === "finish" ? "btn-primary" : ""}`} onClick={() => setSelectionMode("finish")}>2 · Конец</button>
              <span className="text-xs text-[#8fa2ae]">{selectionMode === "start" ? "Щёлкните по дороге, чтобы задать старт" : "Щёлкните по дороге, чтобы задать финиш"}</span>
              <button type="button" className="btn btn-mini ml-auto" onClick={() => { setStartPoint(null); setFinishPoint(null); setPreview(null); setSelectionMode("start"); }}>Сбросить точки</button>
            </div>
            <div className="rounded-xl overflow-hidden border border-white/10 bg-[#09131b]">
              <svg
                viewBox={`${bounds.minX} ${-bounds.maxZ} ${viewWidth} ${viewHeight}`}
                preserveAspectRatio="none"
                className="w-full h-[360px] cursor-crosshair"
                role="img"
                aria-label="Схема дорожной сети OSM. Выберите начало и конец маршрута."
                onClick={handleMapClick}
              >
                <rect x={bounds.minX} y={-bounds.maxZ} width={viewWidth} height={viewHeight} fill="#09131b" />
                {(sourceDef.roads ?? []).map((road) => (
                  <polyline key={road.id} points={road.points.map((point) => `${point.x},${-point.z}`).join(" ")} fill="none" stroke={road.oneway ? "#4c7890" : "#355365"} strokeWidth={Math.max(1.5, road.width)} strokeLinecap="round" strokeLinejoin="round" opacity="0.82" />
                ))}
                {displayPath.length >= 2 && <polyline points={displayPath.map((point) => `${point.x},${-point.z}`).join(" ")} fill="none" stroke="#f5b942" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />}
                {startPoint && <g><circle cx={startPoint.x} cy={-startPoint.z} r="5" fill="#52d6bd" stroke="#071018" strokeWidth="1.5" /><text x={startPoint.x + 7} y={-startPoint.z - 7} fill="#b8ffef" fontSize="10" fontWeight="bold">СТАРТ</text></g>}
                {finishPoint && <g><circle cx={finishPoint.x} cy={-finishPoint.z} r="5" fill="#ff7b7b" stroke="#071018" strokeWidth="1.5" /><text x={finishPoint.x + 7} y={-finishPoint.z - 7} fill="#ffc2c2" fontSize="10" fontWeight="bold">ФИНИШ</text></g>}
              </svg>
            </div>
            <div className="grid md:grid-cols-[1fr_150px_160px] gap-3">
              <label className="text-xs text-[#8fa2ae]">Название маршрута
                <input value={title} onChange={(event) => { setTitle(event.target.value); setPreview(null); }} placeholder="Например, Центральный — маршрут №1" maxLength={80} className="field mt-1 w-full" />
              </label>
              <label className="text-xs text-[#8fa2ae]">Интервал КТ, м
                <input type="number" min={35} max={250} step={5} value={spacing} onChange={(event) => { setSpacing(Math.max(35, Math.min(250, Number(event.target.value) || 90))); setPreview(null); }} className="field mt-1 w-full" />
              </label>
              <div className="flex items-end">
                <button type="button" className="btn btn-primary w-full" onClick={handleBuild} disabled={!startPoint || !finishPoint}>Построить и проверить</button>
              </div>
            </div>
            {preview && (
              <div className={`panel-soft p-4 ${preview.ok ? "border border-[#52d6bd]/30" : "border border-[#ff7b7b]/30"}`}>
                {preview.ok ? (
                  <>
                    <div className="flex flex-wrap justify-between gap-2">
                      <div className="font-bold text-[#52d6bd]">Маршрут построен по дорожному графу</div>
                      <div className="mono text-sm">{(preview.record.lengthM / 1000).toFixed(2)} км · {preview.record.checkpoints.length} КТ</div>
                    </div>
                    <div className="text-xs text-[#b9c9d3] mt-2">Улицы: {preview.record.roadNames.join(" → ") || "названия отсутствуют в OSM"}</div>
                    <div className="text-[10px] text-[#8fa2ae] mt-1">One-way и уровни мостов/тоннелей учитываются существующим маршрутизатором.</div>
                    <button type="button" className="btn btn-primary mt-3" onClick={() => void handleSave()}><Icon name="check" size={14} /> Сохранить в каталог</button>
                  </>
                ) : (
                  <div className="text-sm text-[#ff9b9b]">{preview.error}</div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel p-5">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
          <div><h3 className="text-lg font-extrabold">Сохранённые маршруты</h3><p className="text-xs text-[#8fa2ae] mt-1">Каждая запись содержит независимый снимок OSM-карты для последующего запуска.</p></div>
          {loading && <span className="text-xs text-[#8fa2ae]">Загрузка каталога…</span>}
        </div>
        {!loading && routes.length === 0 && <div className="panel-soft p-5 text-sm text-[#8fa2ae]">Каталог пока пуст. Импортируйте OSM-карту и создайте первый маршрут.</div>}
        <div className="space-y-3">
          {routes.map((route) => (
            <article key={route.id} className="panel-soft p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-bold truncate">{route.title}</h4>
                    {currentMapMismatch(route) && <ChipFallback>другая версия карты</ChipFallback>}
                  </div>
                  <div className="text-xs text-[#8fa2ae] mt-1">{route.mapTitle} · {(route.lengthM / 1000).toFixed(2)} км · {route.checkpoints.length} КТ</div>
                  <div className="text-xs text-[#b9c9d3] mt-2">{route.roadNames.join(" → ") || "Названия улиц не указаны"}</div>
                  <div className="text-[10px] mono text-[#6e8492] mt-2">ODbL 1.0 · {route.mapFingerprint} · {new Date(route.updatedAt).toLocaleDateString("ru-RU")}</div>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <button type="button" className="btn btn-mini btn-primary" onClick={() => onOpenRoute(route.scenarioSnapshot)}><Icon name="play" size={13} /> Открыть</button>
                  <button type="button" className="btn btn-mini" onClick={() => downloadJson(`${route.id}.json`, route, onNotify)} title="Экспорт маршрута"><Icon name="download" size={13} /></button>
                  <button type="button" className="btn btn-mini btn-danger" onClick={() => void handleDelete(route)} title="Удалить маршрут"><Icon name="trash" size={13} /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
      <div className="text-[10px] text-[#6e8492] leading-relaxed">Данные карты: {sourceDef.mapMeta?.attribution ?? "© OpenStreetMap contributors"} · лицензия {sourceDef.mapMeta?.license ?? "ODbL 1.0"}. Маршрут — учебная конфигурация, а не официальная экзаменационная трасса.</div>
    </div>
  );
}

function ChipFallback({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold bg-[#f5b942]/10 text-[#f5b942] border border-[#f5b942]/20">{children}</span>;
}
