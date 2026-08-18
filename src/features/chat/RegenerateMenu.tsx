import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check } from '../../components/ui/glyphs';
import type { Provider } from '../../db/types';
import { modelEntries, modelLabel } from '../../lib/ai/models';
import { useT } from '../../lib/i18n';

interface Props {
  /** Прямоугольник кнопки «Повторить» — точка позиционирования портала. */
  rect: DOMRect;
  providers: Provider[];
  currentProviderId: string | null;
  currentModel: string | null;
  onClose: () => void;
  /** Без опций — «та же модель» (использует текущие модель/провайдер чата). */
  onPick: (opts?: { model: string; providerId: string }) => void;
}

/**
 * Поповер выбора модели для регенерации ответа. По образцу RowMenu из
 * Sidebar: портал, fixed-позиционирование от rect кнопки, закрытие по Esc
 * или клику мимо.
 */
export function RegenerateMenu({ rect, providers, currentProviderId, currentModel, onClose, onPick }: Props) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const left = Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248));
  const openDown = rect.bottom + 320 < window.innerHeight;
  const style: React.CSSProperties = openDown
    ? { left, top: rect.bottom + 4 }
    : { left, bottom: window.innerHeight - rect.top + 4 };

  const itemClass =
    'flex w-full items-center gap-2.5 rounded-[var(--cc-radius-sm)] px-2.5 py-2.5 text-left text-sm hover:bg-[var(--cc-fill-ghost-hover)] active:opacity-60';

  return createPortal(
    <>
      <button aria-label={t('common.close')} className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        style={style}
        className="animate-fade-in fixed z-[61] max-h-80 w-60 overflow-y-auto rounded-[var(--cc-radius)] border border-hairline bg-elevated p-1 shadow-[var(--shadow-pop)]"
      >
        <button
          className={itemClass}
          onClick={() => {
            onPick();
            onClose();
          }}
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="block truncate">{t('msg.retrySame')}</span>
            <span className="block truncate font-mono text-[length:var(--cc-text-caption)] text-muted">
              {modelLabel(currentModel)}
            </span>
          </span>
        </button>
        <div className="my-1 border-t border-hairline" />
        {providers.map((p) => (
          <div key={p.id}>
            <p className="px-2 pt-2 pb-1 text-[length:var(--cc-text-caption)] font-medium tracking-[0.06em] text-muted uppercase">
              {p.name}
            </p>
            {modelEntries(p.models).map((m) => {
              const active = p.id === currentProviderId && m.id === currentModel;
              return (
                <button
                  key={`${p.id}:${m.id}`}
                  className={itemClass}
                  onClick={() => {
                    onPick({ model: m.id, providerId: p.id });
                    onClose();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{modelLabel(m.id)}</span>
                  {active && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
}
