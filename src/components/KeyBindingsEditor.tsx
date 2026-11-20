/**
 * @module components/KeyBindingsEditor
 * @layer ui
 * @role Меню переназначения клавиш с захватом следующей клавиши, отменой и сбросом.
 * @invariants Захват не передаёт нажатие в управление автомобилем; конфликтующие назначения отклоняются.
 * @tests Browser Smoke A2i–A2k.
 */
import { useRef, useState } from "react";
import { bindingErrors, bindingConflict, bindKey, defaultKeyBindings, KEY_ACTIONS, keyLabel, validBinding, type KeyBindings } from "../input/keyBindings";

export function KeyBindingsEditor({ value, onChange }: { value: KeyBindings; onChange: (value: KeyBindings) => void }) {
  const capturedKey = useRef<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const errors = bindingErrors(value);
  return <details className="mb-4 border hairline rounded-lg p-2" data-testid="keybindings-editor">
    <summary className="cursor-pointer text-xs font-bold text-[#f5b942]">Назначение клавиш</summary>
    <p className="text-[10px] text-[#9bafbc] my-2">Нажмите назначение, затем новую клавишу. Esc — отмена. Одна клавиша — одна команда. Занятые клавиши назначить нельзя. Shift — отдельный модификатор ручного режима и педалей.</p>
    <p data-testid="keybindings-validation" className={errors.length ? "text-xs text-red-300 mb-2" : "text-xs text-[#52d6bd] mb-2"}>
      {errors.length ? `Конфликты: ${errors.join("; ")}` : "Проверка: конфликтов нет — одна клавиша, одна команда"}
    </p>
    <div className="space-y-1">
      {KEY_ACTIONS.map(([action, label]) => <div key={action} className="flex items-center justify-between gap-2 text-[11px]">
        <span>{label}</span>
        <button type="button" className="btn btn-mini shrink-0" aria-label={`Назначить: ${label}`} aria-pressed={waiting === action}
          onClick={() => { setWaiting(action); setMessage(""); }}
          onBlur={() => { setWaiting(null); capturedKey.current = null; }}
          onKeyDown={(e) => {
            if (capturedKey.current) { e.preventDefault(); e.stopPropagation(); return; }
            if (waiting !== action) return;
            e.preventDefault(); e.stopPropagation();
            capturedKey.current = e.code;
            if (e.code === "Escape") { setWaiting(null); return; }
            if (e.ctrlKey || e.altKey || e.metaKey || !validBinding(e.code)) {
              setMessage("Выберите букву, цифру, стрелку, Shift, пробел или Backspace без Ctrl/Alt/Meta."); return;
            }
            const conflict = bindingConflict(value, action, e.code);
            if (conflict) { setMessage(conflict); setWaiting(null); return; }
            const next = bindKey(value, action, e.code);
            if (bindingErrors(next).length) { setMessage("Ошибка раскладки. Сбросьте назначения клавиш."); setWaiting(null); return; }
            onChange(next); setWaiting(null); setMessage("Назначение изменено. Конфликтов нет.");
          }} onKeyUp={(e) => { capturedKey.current = null; e.preventDefault(); e.stopPropagation(); }}>
          {waiting === action ? "Нажмите клавишу…" : keyLabel(value[action])}
        </button>
      </div>)}
    </div>
    <p data-testid="keybindings-message" className="text-[10px] text-[#f5b942] mt-2" role="status">{message}</p>
    <button type="button" className="btn btn-mini mt-2" onClick={() => { onChange(defaultKeyBindings()); setWaiting(null); setMessage("Стандартные клавиши восстановлены."); }}>Сбросить назначения клавиш</button>
  </details>;
}
