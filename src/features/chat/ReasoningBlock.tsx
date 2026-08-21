// Отдельный файл: блок мыслей нужен и ChatPage, и CompareGroup — импорт из
// ChatPage дал бы цикл (CompareGroup рендерится внутри ChatPage).

import { useState } from 'react';
import { ChevronRight } from '../../components/ui/glyphs';
import { useT } from '../../lib/i18n';

/**
 * Свёрнутый по умолчанию блок «мыслей» готового ответа. Это не отладочная
 * строка, а часть ответа думающей модели — и оплаченная часть, поэтому
 * рядом с подписью стоит объём.
 */
export function ReasoningBlock({ text, tokens }: { text: string; tokens?: number | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="cc-hit inline-flex items-center gap-1.5 rounded-[var(--cc-radius-sm)] bg-surface px-2 py-1 font-mono text-[length:var(--cc-text-caption)] text-muted"
      >
        <ChevronRight
          size={12}
          className={`transition-transform duration-[var(--cc-dur-snap)] ${open ? 'rotate-90' : ''}`}
        />
        {t('reasoning.label')}
        {tokens ? <span className="cc-num opacity-70">· {tokens}</span> : null}
      </button>
      {open && (
        <div className="mt-1.5 mb-2 rounded-[var(--cc-radius-sm)] border-l-2 border-accent/40 bg-surface px-3 py-2 font-mono text-[length:var(--cc-text-meta)] whitespace-pre-wrap text-muted">
          {text}
        </div>
      )}
    </div>
  );
}

/** Мысли во время стриминга — всегда развёрнуты, без кнопки сворачивания. */
export function LiveReasoning({ text }: { text: string }) {
  const t = useT();
  return (
    <div>
      <p className="flex items-center gap-1 font-mono text-[length:var(--cc-text-caption)] text-muted">{t('reasoning.label')}</p>
      <div className="mt-1 border-l-2 border-hairline pl-3 font-mono text-[length:var(--cc-text-meta)] whitespace-pre-wrap text-muted">
        {text}
      </div>
    </div>
  );
}
