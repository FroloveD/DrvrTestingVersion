/**
 * @module maps/osmXml
 * @layer pure-core
 * @role Автономный парсер стандартных файлов `.osm` (XML с openstreetmap.org и JOSM) без DOMParser и внешних пакетов.
 * @invariants #7 (чистое ядро — исполняется в Node.js и браузере без DOM), #8 (строго офлайн), #9 (ODbL 1.0).
 * @tests T27
 */

/** Унифицированный элемент OSM, совместимый со структурой Overpass JSON (`node` / `way`). */
export type RawOsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
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
 * Разбирает содержимое локального файла `.osm` (XML v0.6) в список `node` и `way`
 * с координатами, ссылками `<nd ref="..."/>` и тегами `<tag k="..." v="..."/>`.
 * Поддерживает как самозакрывающиеся `<node .../>`, так и вложенные блоки, а также
 * формат Overpass XML (`<nd lat="..." lon="..."/>`).
 */
export function parseOsmXmlElements(xml: string): RawOsmElement[] {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new Error("OSM XML-файл пуст.");
  }
  // Убираем BOM и XML-комментарии
  const cleaned = xml.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (!/<osm[\s>]/i.test(cleaned)) {
    throw new Error("Не найден корневой тег <osm>: ожидается выгрузка OpenStreetMap (.osm XML).");
  }

  const elements: RawOsmElement[] = [];
  const tagRe = /<(\/?)(node|way|nd|tag)\b([^>]*?)(\/?)>/gi;
  let current: RawOsmElement | null = null;
  let skipChildren = false;
  let autoId = 1_000_000;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const isClosing = match[1] === "/";
    const name = match[2].toLowerCase();
    const attrPart = match[3];
    const isSelfClosing = match[4] === "/";

    if (isClosing) {
      if ((name === "node" || name === "way") && current && current.type === name) {
        elements.push(current);
        current = null;
      }
      if (name === "node" || name === "way") {
        skipChildren = false;
      }
      continue;
    }

    if (name === "node") {
      if (current) {
        elements.push(current);
        current = null;
      }
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

    if (skipChildren || !current) continue;

    if (name === "nd" && current.type === "way") {
      const attrs = parseAttributes(attrPart);
      if (attrs.ref !== undefined) {
        const ref = Number(attrs.ref);
        if (Number.isFinite(ref)) {
          current.nodes = current.nodes ?? [];
          current.nodes.push(ref);
        }
      }
      if (attrs.lat !== undefined && attrs.lon !== undefined) {
        const lat = Number(attrs.lat);
        const lon = Number(attrs.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          current.geometry = current.geometry ?? [];
          current.geometry.push({ lat, lon });
        }
      }
      continue;
    }

    if (name === "tag") {
      const attrs = parseAttributes(attrPart);
      if (attrs.k && attrs.v !== undefined) {
        current.tags = current.tags ?? {};
        current.tags[attrs.k] = attrs.v;
      }
    }
  }

  if (current) elements.push(current);
  if (elements.length === 0) {
    throw new Error("В .osm XML не найдено ни одного узла <node> или линии <way>.");
  }
  return elements;
}
