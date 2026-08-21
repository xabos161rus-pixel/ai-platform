import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type Toast, type ToastKind } from './toastContext';
import { Check, X } from './glyphs';

interface Item {
  id: number;
  text: string;
  kind: ToastKind;
  leaving: boolean;
}

const LIFE_MS = 2600;
const EXIT_MS = 140;
/** Больше трёх на экране — уже стена, а не подсказка. */
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);

  const drop = useCallback((id: number) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, leaving: true } : i)));
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), EXIT_MS);
  }, []);

  const toast = useCallback<Toast>(
    (text, kind = 'info') => {
      const id = ++seq.current;
      // Раньше новый тост затирал предыдущий: две ошибки подряд — и вторая
      // съедала первую вместе с её причиной.
      setItems((prev) => [...prev, { id, text, kind, leaving: false }].slice(-MAX_VISIBLE));
      setTimeout(() => drop(id), LIFE_MS);
    },
    [drop],
  );

  return (
    <ToastContext value={toast}>
      {children}
      {items.length > 0 && (
        <div
          // Отступ снизу больше не зашит числом 84: композер сообщает свою
          // фактическую высоту, а на страницах без него переменной просто нет.
          className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+var(--cc-composer-h,0px)+16px)] z-[var(--cc-z-toast)] flex flex-col items-center gap-2 px-4"
          role="status"
          aria-live="polite"
        >
          {items.map((i) => (
            <div
              key={i.id}
              className={`pointer-events-auto flex max-w-sm cursor-pointer items-start gap-2.5 rounded-[var(--cc-radius)] border border-hairline bg-elevated px-4 py-2.5 text-left text-[length:var(--cc-text-meta)] shadow-[var(--cc-elev-overlay)] ${i.leaving ? 'animate-fade-out' : 'animate-pop-in'}`}
              onClick={() => drop(i.id)}
            >
              {i.kind === 'success' && <Check size={15} className="mt-px shrink-0 text-success" />}
              {i.kind === 'error' && <X size={15} className="mt-px shrink-0 text-danger" />}
              <span>{i.text}</span>
            </div>
          ))}
        </div>
      )}
    </ToastContext>
  );
}
