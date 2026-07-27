import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type Toast } from './toastContext';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback<Toast>((t) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 2600);
  }, []);

  return (
    <ToastContext value={toast}>
      {children}
      {text && (
        <div className="animate-fade-in pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-[60] flex justify-center px-4">
          <div className="max-w-sm rounded-[var(--cc-radius)] bg-surface-2 px-4 py-2.5 text-center text-sm shadow-[var(--shadow-pop)]">
            {text}
          </div>
        </div>
      )}
    </ToastContext>
  );
}
