import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from './glyphs';
import { useT } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/** Нижняя панель — контейнер списков и форм. */
export function Sheet({ open, onClose, title, children }: Props) {
  const t = useT();
  // Esc закрывает — на маке это ожидаемое поведение.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    // Телефон: панель снизу во всю ширину. Десктоп: центрированная панель —
    // форма на 2000px во весь экран с километровой кнопкой «Сохранить»
    // выглядела разъехавшейся простынёй.
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6">
      <button
        aria-label={t('common.close')}
        className="absolute inset-0 bg-black/50 animate-fade-in"
        onClick={onClose}
      />
      <div className="animate-sheet-up relative max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border-t border-hairline bg-surface pb-[calc(env(safe-area-inset-bottom)+16px)] sm:max-w-xl sm:rounded-2xl sm:border sm:pb-4 sm:shadow-[0_24px_64px_-24px_rgba(0,0,0,0.5)]">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-hairline bg-surface px-4 py-3">
          <h2 className="flex-1 text-lg font-semibold">{title}</h2>
          <button
            aria-label={t('common.close')}
            className="grid size-9 place-items-center rounded-full bg-surface-2 active:opacity-70"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
