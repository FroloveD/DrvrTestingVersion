import type { ReactNode } from "react";

const ICONS: Record<string, string> = {
  car: "M5 17h14v-5l-2-5H7l-2 5z|M3 17h18|M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4|M17 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4|M6 12h12",
  play: "M6 4l14 8-14 8z",
  pause: "M7 5h3v14H7z|M14 5h3v14h-3z",
  reset: "M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5",
  arrow: "M5 12h14|M13 6l6 6-6 6",
  external: "M14 4h6v6|M20 4l-9 9|M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  copy: "M9 9h10v10H9z|M5 15H4V4h11v1",
  download: "M12 3v12|M7 10l5 5 5-5|M4 19h16",
  upload: "M12 15V3|M7 8l5-5 5 5|M4 19h16",
  check: "M4 12l5 5L20 6",
  alert: "M12 3l10 18H2z|M12 9v5|M12 17h.01",
  layers: "M12 3l9 5-9 5-9-5z|M3 13l9 5 9-5|M3 17l9 5 9-5",
  target: "M21 12a9 9 0 1 1-9-9|M16 12a4 4 0 1 1-4-4|M12 11v2h2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z|M9 12l2 2 4-4",
  cpu: "M6 6h12v12H6z|M9 1v5|M15 1v5|M9 18v5|M15 18v5|M1 9h5|M1 15h5|M18 9h5|M18 15h5",
  clipboard: "M8 4h8v3H8z|M6 5H4v16h16V5h-2|M8 12h8|M8 16h6",
  spark: "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z",
  file: "M6 2h8l5 5v15H6z|M14 2v5h5",
  route: "M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4|M18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4|M6 8v6a4 4 0 0 0 4 4h6",
  chart: "M3 3v18h18|M7 16v-5|M12 16V7|M17 16v-8|M6 16h12",
  grid: "M3 3h7v7H3z|M14 3h7v7h-7z|M3 14h7v7H3z|M14 14h7v7h-7z",
  scale: "M12 3v18|M5 7h14|M5 7l-3 6h6z|M19 7l-3 6h6z|M8 21h8",
  sliders: "M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  camera: "M3 7h4l2-2h6l2 2h4v12H3z|M12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20|M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 4|M12 17h.01",
  trash: "M3 6h18|M8 6V4h8v2|M6 6l1 14h10l1-14",
  github:
    "M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.4 9.4 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z",
};

export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {(ICONS[name] || ICONS.spark).split("|").map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "amber" | "mint" | "red" | "neutral";
  className?: string;
}) {
  return <span className={`chip tag-${tone} ${className}`}>{children}</span>;
}

export function copyText(text: string, onDone: (msg: string) => void, msg = "Скопировано в буфер обмена"): void {
  const done = () => onDone(msg);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // clipboard unavailable
  }
  document.body.removeChild(ta);
  done();
}

export function CopyButton({
  text,
  label = "Скопировать",
  onDone,
}: {
  text: string;
  label?: string;
  onDone: (msg: string) => void;
}) {
  return (
    <button type="button" className="btn btn-mini" onClick={() => copyText(text, onDone)}>
      <Icon name="copy" size={13} /> {label}
    </button>
  );
}

export function downloadTextFile(
  filename: string,
  content: string,
  mime = "text/plain;charset=utf-8",
  onDone?: (msg: string) => void,
  withBom = false
): void {
  const payload = withBom ? `\uFEFF${content}` : content;
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  onDone?.(`Файл ${filename} сохранён`);
}

export function downloadJson(filename: string, data: unknown, onDone?: (msg: string) => void): void {
  downloadTextFile(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8", onDone, false);
}
