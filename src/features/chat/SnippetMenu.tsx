import { forwardRef, useImperativeHandle, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listSnippets } from '../../lib/ai/snippetRepo';
import type { Snippet } from '../../db/types';
import { useT } from '../../lib/i18n';

export interface SnippetMenuHandle {
  moveUp(): void;
  moveDown(): void;
  /** Вставить выделенную строку. Возвращает false, если вставлять нечего. */
  confirmSelected(): boolean;
}

interface Props {
  /** Текст после «/» — фильтр по заголовку сниппета. */
  query: string;
  onPick: (text: string) => void;
}

/**
 * Всплывающее «/»-меню сниппетов над композером. Открытием/закрытием и
 * Enter/Tab-политикой заведует Composer (клавиатура слушается на textarea);
 * этот компонент только фильтрует список и двигает подсветку — наружу отдан
 * через ref, по тому же паттерну, что и ComposerHandle.
 */
export const SnippetMenu = forwardRef<SnippetMenuHandle, Props>(function SnippetMenu({ query, onPick }, ref) {
  const t = useT();
  const rows = useLiveQuery(() => listSnippets(), [], [] as Snippet[]);
  const filtered = rows.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

  const [selected, setSelected] = useState(0);
  // Сброс подсветки при смене фильтра — правка состояния прямо во время
  // рендера (без эффекта), стандартный паттерн React для «состояния,
  // производного от пропа»: react-hooks/set-state-in-effect не касается этого.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setSelected(0);
  }
  const idx = Math.min(selected, Math.max(0, filtered.length - 1));

  useImperativeHandle(
    ref,
    () => ({
      moveUp() {
        setSelected((i) => Math.max(0, i - 1));
      },
      moveDown() {
        setSelected((i) => Math.min(filtered.length - 1, i + 1));
      },
      confirmSelected() {
        const row = filtered[idx];
        if (!row) return false;
        onPick(row.text);
        return true;
      },
    }),
    [filtered, idx, onPick],
  );

  return (
    <div
      role="listbox"
      className="cc-scroll absolute inset-x-0 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-[var(--cc-radius)] border border-hairline bg-elevated p-1 shadow-[var(--shadow-pop)]"
    >
      {filtered.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted">{t('snippets.empty')}</p>
      ) : (
        filtered.map((s, i) => (
          <button
            key={s.id}
            role="option"
            aria-selected={i === idx}
            className={`flex min-h-[var(--cc-touch)] w-full flex-col items-start justify-center gap-0.5 rounded-[var(--cc-radius-sm)] px-3 py-1.5 text-left ${
              i === idx ? 'bg-[var(--cc-fill-ghost-hover)]' : ''
            }`}
            onClick={() => onPick(s.text)}
          >
            <span className="truncate text-sm font-medium">{s.title}</span>
            <span className="w-full truncate font-mono text-[length:var(--cc-text-caption)] text-muted">
              {s.text.slice(0, 60)}
            </span>
          </button>
        ))
      )}
    </div>
  );
});
