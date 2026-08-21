import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from './glyphs';
import { useT } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/** Длительность ухода — 0.7 от прихода, как во всей системе движения. */
const EXIT_MS = 180;

/** Нижняя панель — контейнер списков и форм. */
export function Sheet({ open, onClose, title, children }: Props) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Панель раньше исчезала скачком: появление плавное, размонтирование
  // мгновенное. Держим её на экране, пока играет обратная анимация.
  // Переключение — в фазе рендера (правило проекта запрещает setState в
  // теле эффекта), снятие — по таймеру.
  const [prevOpen, setPrevOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setLeaving(!open);
  }
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(false), EXIT_MS);
    return () => window.clearTimeout(id);
  }, [leaving]);
  const mounted = open || leaving;

  // Esc закрывает — на маке это ожидаемое поведение. Tab держим внутри
  // панели: без этого фокус уезжал на страницу под затемнением.
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnTo?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    // Телефон: панель снизу во всю ширину. Десктоп: центрированная панель —
    // форма на 2000px во весь экран с километровой кнопкой «Сохранить»
    // выглядела разъехавшейся простынёй.
    <div
      className="fixed inset-0 z-[var(--cc-z-sheet)] flex flex-col justify-end sm:items-center sm:justify-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      <button
        aria-label={t('common.close')}
        className={`absolute inset-0 bg-[var(--cc-scrim)] backdrop-blur-[3px] ${leaving ? 'animate-fade-out' : 'animate-fade-in'}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={`cc-scroll relative max-h-[85dvh] w-full overflow-y-auto rounded-t-[var(--cc-radius-xl)] border-t border-hairline bg-elevated pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-[var(--cc-elev-modal)] sm:max-w-xl sm:rounded-[var(--cc-radius-xl)] sm:border sm:pb-4 ${leaving ? 'animate-sheet-down sm:animate-fade-out' : 'animate-sheet-up sm:animate-pop-in'}`}
      >
        {/* Ручка-грабер: на телефоне подсказывает, что панель тянется снизу. */}
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--cc-fill-control)] sm:hidden"
        />
        <div className="sticky top-0 z-[var(--cc-z-sticky)] flex items-center gap-2 border-b border-hairline bg-elevated px-4 py-3">
          <h2 id={titleId} className="flex-1 text-[length:var(--cc-text-h1)] font-semibold">
            {title}
          </h2>
          <button
            aria-label={t('common.close')}
            className="cc-hit grid size-10 place-items-center rounded-full bg-surface-2"
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
