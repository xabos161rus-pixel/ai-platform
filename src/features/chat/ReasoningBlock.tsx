// Отдельный файл: блок мыслей нужен и ChatPage, и CompareGroup — импорт из
// ChatPage дал бы цикл (CompareGroup рендерится внутри ChatPage).

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useT } from '../../lib/i18n';

/** Свёрнутый по умолчанию блок «мыслей» готового ответа. */
export function ReasoningBlock({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-mono text-[var(--cc-text-caption)] text-muted transition-colors hover:text-text active:opacity-60"
      >
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('reasoning.label')}
      </button>
      {open && (
        <div className="mt-1 mb-2 border-l-2 border-hairline pl-3 font-mono text-[var(--cc-text-meta)] whitespace-pre-wrap text-muted">
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
      <p className="flex items-center gap-1 font-mono text-[var(--cc-text-caption)] text-muted">{t('reasoning.label')}</p>
      <div className="mt-1 border-l-2 border-hairline pl-3 font-mono text-[var(--cc-text-meta)] whitespace-pre-wrap text-muted">
        {text}
      </div>
    </div>
  );
}
