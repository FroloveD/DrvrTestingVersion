/**
 * @module components/KeyBindingsEditor
 * @layer ui
 * @role Меню переназначения клавиш с захватом следующей клавиши, отменой и сбросом.
 * @invariants Захват не передаёт нажатие в управление автомобилем; конфликты разрешаются обменом.
 * @tests Browser Smoke A2i–A2k.
 */
import { useState } from "react";
import { bindKey, defaultKeyBindings, KEY_ACTIONS, keyLabel, validBinding, type KeyBindings } from "../input/keyBindings";

export function KeyBindingsEditor({ value, onChange }: { value: KeyBindings; onChange: (value: KeyBindings) => void }) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  return <details className="mb-4 border hairline rounded-lg p-2" data-testid="keybindings-editor">
    <summary className="cursor-pointer text-xs font-bold text-[#f5b942]">Назначение клавиш</summary>
    <p className="text-[10px] text-[#9bafbc] my-2">Нажмите назначение, затем новую клавишу. Esc — отмена. Занятые клавиши меняются местами. Shift — отдельный модификатор ручного режима и педалей.</p>
    <div className="space-y-1">
      {KEY_ACTIONS.map(([action, label]) => <div key={action} className="flex items-center justify-between gap-2 text-[11px]">
        <span>{label}</span>
        <button type="button" className="btn btn-mini shrink-0" aria-label={`Назначить: ${label}`} aria-pressed={waiting === action}
          onClick={() => { setWaiting(action); setMessage(""); }}
          onBlur={() => setWaiting(null)}
          onKeyDown={(e) => {
            if (waiting !== action) return;
            e.preventDefault(); e.stopPropagation();
            if (e.code === "Escape") { setWaiting(null); return; }
            if (e.ctrlKey || e.altKey || e.metaKey || !validBinding(e.code)) {
              setMessage("Выберите букву, цифру, стрелку, Shift, пробел или Backspace без Ctrl/Alt/Meta."); return;
            }
            onChange(bindKey(value, action, e.code)); setWaiting(null); setMessage("Назначение изменено.");
          }} onKeyUp={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {waiting === action ? "Нажмите клавишу…" : keyLabel(value[action])}
        </button>
      </div>)}
    </div>
    <p className="text-[10px] text-[#9bafbc] mt-2" role="status">{message}</p>
    <button type="button" className="btn btn-mini mt-2" onClick={() => { onChange(defaultKeyBindings()); setWaiting(null); setMessage("Стандартные клавиши восстановлены."); }}>Сбросить назначения клавиш</button>
  </details>;
}
