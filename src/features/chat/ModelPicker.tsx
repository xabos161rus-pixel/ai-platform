import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from '../../components/ui/glyphs';
import type { Provider } from '../../db/types';
import { modelIds, modelLabel } from '../../lib/ai/models';
import { useT } from '../../lib/i18n';

interface Props {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
}

/**
 * Переключатель модели прямо в шапке чата. Держать его только в настройках
 * нельзя: смена модели — самое частое действие в такой платформе, и ради него
 * нельзя уводить человека с экрана диалога.
 */
export function ModelPicker({ providers, providerId, model, onChange }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = providers.find((p) => p.id === providerId);

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex max-w-[60vw] items-center gap-1 rounded-[var(--cc-radius-sm)] px-1.5 py-0.5 font-mono text-[length:var(--cc-text-caption)] text-muted transition-colors hover:bg-[var(--cc-fill-ghost-hover)] hover:text-text"
      >
        <span className="truncate">
          {current?.isDemo ? t('modelpicker.demo') : (current?.name ?? t('modelpicker.noProvider'))} · {modelLabel(model)}
        </span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="animate-fade-in absolute top-full left-0 z-40 mt-1 max-h-80 w-72 overflow-y-auto rounded-[var(--cc-radius)] border border-hairline bg-elevated p-1 shadow-[var(--shadow-pop)]">
          {providers.map((p) => (
            <div key={p.id}>
              <p className="px-2 pt-2 pb-1 text-[length:var(--cc-text-caption)] font-medium tracking-[0.06em] text-muted uppercase">
                {p.name}
              </p>
              {modelIds(p.models).map((m) => {
                const active = p.id === providerId && m === model;
                return (
                  <button
                    key={`${p.id}:${m}`}
                    onClick={() => {
                      onChange(p.id, m);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-[var(--cc-radius-sm)] px-2 py-2 text-left text-sm transition-colors ${
                      active ? 'bg-[var(--cc-fill-control)]' : 'hover:bg-[var(--cc-fill-ghost-hover)]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{modelLabel(m)}</span>
                    {active && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
