/**
 * @module maps/osmXml
 * @layer pure-core
 * @role Автономный парсер стандартных файлов `.osm` (XML v0.6 с openstreetmap.org, JOSM и Overpass), включая `<bounds>` и `<relation>` мультиполигонов, без DOMParser и внешних пакетов.
 * @invariants #7 (чистое ядро — исполняется в Node.js и браузере без DOM), #8 (строго офлайн), #9 (ODbL 1.0).
 * @tests T27, T30, T33
 */

/** Участник отношения OSM (`<member type="way|node|relation" ref="..." role="outer|inner|..."/>`). */
export type RawOsmMember = {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
  geometry?: Array<{ lat: number; lon: number }>;
};

/** Унифицированный элемент OSM, совместимый со структурой Overpass JSON (`node` / `way` / `relation`). */
export type RawOsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: RawOsmMember[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};

export type ParsedOsmXmlDoc = {
  elements: RawOsmElement[];
  /** Рамка экспорта `<bounds minlat minlon maxlat maxlon/>` в формате `[minLon, minLat, maxLon, maxLat]`. */
  exportBbox?: [number, number, number, number];
};

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Декодирует стандартные и числовые XML-сущности в значениях атрибутов `<tag v="..."/>`. */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (code.startsWith("#")) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    return XML_ENTITIES[code] ?? full;
  });
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const val = m[2] !== undefined ? m[2] : m[3] ?? "";
    attrs[m[1]] = decodeXmlEntities(val);
  }
  return attrs;
}

function isIgnoredElement(attrs: Record<string, string>): boolean {
  return attrs.action === "delete" || attrs.visible === "false";
}

/**
 * Разбирает содержимое локального файла `.osm` (XML v0.6) в структуру `{ elements, exportBbox }`.
 * Поддерживает `<bounds/>`, `<node>`, `<way>`, `<relation>` (мультиполигоны зданий с дворами и границы маршрутов)
 * и Overpass XML (`<nd lat lon/>`, `<member ...><nd lat lon/></member>`).
 */
export function parseOsmXmlDocument(xml: string): ParsedOsmXmlDoc {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new Error("OSM XML-файл пуст.");
  }
  const cleaned = xml.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (!/<osm[\s>]/i.test(cleaned)) {
    throw new Error("Не найден корневой тег <osm>: ожидается выгрузка OpenStreetMap (.osm XML).");
  }

  let exportBbox: [number, number, number, number] | undefined;
  const boundsMatch = cleaned.match(/<bounds\b([^>]*?)\/?>/i);
  if (boundsMatch) {
    const ba = parseAttributes(boundsMatch[1]);
    const minLat = Number(ba.minlat);
    const minLon = Number(ba.minlon);
    const maxLat = Number(ba.maxlat);
    const maxLon = Number(ba.maxlon);
    if (
      Number.isFinite(minLat) &&
      Number.isFinite(minLon) &&
      Number.isFinite(maxLat) &&
      Number.isFinite(maxLon) &&
      maxLat > minLat &&
      maxLon > minLon
    ) {
      exportBbox = [minLon, minLat, maxLon, maxLat];
    }
  }

  const elements: RawOsmElement[] = [];
  const tagRe = /<(\/?)(node|way|relation|member|nd|tag)\b([^>]*?)(\/?)>/gi;
  let current: RawOsmElement | null = null;
  let currentMember: RawOsmMember | null = null;
  let skipChildren = false;
  let autoId = 1_000_000;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const isClosing = match[1] === "/";
    const name = match[2].toLowerCase();
    const attrPart = match[3];
    const isSelfClosing = match[4] === "/";

    if (isClosing) {
      if (name === "member") {
        currentMember = null;
        continue;
      }
      if ((name === "node" || name === "way" || name === "relation") && current && current.type === name) {
        elements.push(current);
        current = null;
        currentMember = null;
      }
      if (name === "node" || name === "way" || name === "relation") {
        skipChildren = false;
      }
      continue;
    }

    if (name === "node") {
      if (current) {
        elements.push(current);
        current = null;
      }
      currentMember = null;
      const attrs = parseAttributes(attrPart);
      if (isIgnoredElement(attrs)) {
        skipChildren = !isSelfClosing;
        continue;
      }
      skipChildren = false;
      const rawId = Number(attrs.id);
      const id = Number.isFinite(rawId) ? rawId : autoId++;
      const lat = Number(attrs.lat);
      const lon = Number(attrs.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        skipChildren = !isSelfClosing;
        continue;
      }
      const el: RawOsmElement = { type: "node", id, lat, lon };
      if (isSelfClosing) elements.push(el);
      else current = el;
      continue;
    }

    if (name === "way") {
      if (current) {
        elements.push(current);
        current = null;
      }
      currentMember = null;
      const attrs = parseAttributes(attrPart);
      if (isIgnoredElement(attrs)) {
        skipChildren = !isSelfClosing;
        continue;
      }
      skipChildren = false;
      const rawId = Number(attrs.id);
      const id = Number.isFinite(rawId) ? rawId : autoId++;
      const el: RawOsmElement = { type: "way", id, nodes: [] };
      if (isSelfClosing) elements.push(el);
      else current = el;
      continue;
    }

    if (name === "relation") {
      if (current) {
        elements.push(current);
        current = null;
      }
      currentMember = null;
      const attrs = parseAttributes(attrPart);
      if (isIgnoredElement(attrs)) {
        skipChildren = !isSelfClosing;
        continue;
      }
      skipChildren = false;
      const rawId = Number(attrs.id);
      const id = Number.isFinite(rawId) ? rawId : autoId++;
      const el: RawOsmElement = { type: "relation", id, members: [] };
      if (isSelfClosing) elements.push(el);
      else current = el;
      continue;
    }

    if (skipChildren || !current) continue;

    if (name === "member" && current.type === "relation") {
      const attrs = parseAttributes(attrPart);
      const mType = attrs.type;
      const ref = Number(attrs.ref);
      if ((mType === "node" || mType === "way" || mType === "relation") && Number.isFinite(ref)) {
        const mem: RawOsmMember = {
          type: mType,
          ref,
          role: attrs.role ?? "",
        };
        if (!current.members) current.members = [];
        current.members.push(mem);
        currentMember = isSelfClosing ? null : mem;
      }
      continue;
    }

    if (name === "nd") {
      const attrs = parseAttributes(attrPart);
      if (current.type === "relation" && currentMember && attrs.lat !== undefined && attrs.lon !== undefined) {
        const lat = Number(attrs.lat);
        const lon = Number(attrs.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          if (!currentMember.geometry) currentMember.geometry = [];
          currentMember.geometry.push({ lat, lon });
        }
      } else if (current.type === "way") {
        if (attrs.lat !== undefined && attrs.lon !== undefined) {
          const lat = Number(attrs.lat);
          const lon = Number(attrs.lon);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            if (!current.geometry) current.geometry = [];
            current.geometry.push({ lat, lon });
          }
        } else if (attrs.ref !== undefined) {
          const ref = Number(attrs.ref);
          if (Number.isFinite(ref)) {
            if (!current.nodes) current.nodes = [];
            current.nodes.push(ref);
          }
        }
      }
      continue;
    }

    if (name === "tag") {
      const attrs = parseAttributes(attrPart);
      if (attrs.k && attrs.v !== undefined) {
        if (!current.tags) current.tags = {};
        current.tags[attrs.k] = attrs.v;
      }
    }
  }

  if (current) elements.push(current);
  return { elements, exportBbox };
}

/** Разбирает список элементов `.osm` XML (совместимая обёртка над `parseOsmXmlDocument`). */
export function parseOsmXmlElements(xml: string): RawOsmElement[] {
  return parseOsmXmlDocument(xml).elements;
}
