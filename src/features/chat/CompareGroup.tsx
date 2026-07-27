import { useState } from 'react';
import { Check, Copy, Crown } from 'lucide-react';
import type { Message } from '../../db/types';
import { formatCost, modelLabel } from '../../lib/ai/models';
import { chooseWinner } from '../../lib/ai/chatRepo';
import { Markdown } from './Markdown';
import { ReasoningBlock } from './ReasoningBlock';

interface Props {
  group: Message[];
  onCopy: (text: string) => void;
}

/**
 * Ответы нескольких моделей на один вопрос.
 *
 * На широком экране — колонки рядом: сравнивать имеет смысл только когда
 * видно оба текста одновременно. На телефоне колонки бессмысленны (получились
 * бы полоски по 100px), поэтому вкладки с переключением — но с общей строкой
 * цен, чтобы разница в стоимости была видна без переключения.
 */
export function CompareGroup({ group, onCopy }: Props) {
  const [tab, setTab] = useState(0);
  const winner = group.findIndex((m) => m.chosen);

  return (
    <div className="grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        {/* Сводка: что с чем сравниваем и во сколько обошлось */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[var(--cc-text-caption)] text-muted">
          <span>сравнение · {group.length}</span>
          <span>
            итого{' '}
            {formatCost(group.reduce((s, m) => s + (m.costRub ?? 0), 0))}
          </span>
        </div>

        {/* Телефон: вкладки. Широкий экран: колонки. */}
        <div className="mb-2 flex gap-1 lg:hidden">
          {group.map((m, i) => (
            <button
              key={m.id}
              onClick={() => setTab(i)}
              className={`flex-1 truncate rounded-[var(--cc-radius-sm)] px-2 py-1.5 font-mono text-[var(--cc-text-caption)] transition-colors ${
                tab === i ? 'bg-[var(--cc-fill-control)] text-text' : 'text-muted'
              }`}
            >
              {i === winner && '★ '}
              {modelLabel(m.model)}
            </button>
          ))}
        </div>

        <div className="lg:grid lg:gap-3" style={{ gridTemplateColumns: `repeat(${group.length}, minmax(0, 1fr))` }}>
          {group.map((m, i) => (
            <article
              key={m.id}
              className={`${tab === i ? 'block' : 'hidden'} lg:block rounded-[var(--cc-radius)] border p-3 transition-colors ${
                m.chosen ? 'border-accent' : 'border-hairline'
              }`}
            >
              <header className="mb-2 flex items-center gap-2 border-b border-hairline pb-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--cc-text-caption)] text-muted">
                  {modelLabel(m.model)}
                </span>
                <span className="shrink-0 font-mono text-[var(--cc-text-caption)] text-muted">
                  {formatCost(m.costRub)}
                </span>
              </header>

              {m.status === 'error' ? (
                <p className="text-sm text-danger">{m.error}</p>
              ) : (
                <>
                  {m.reasoning && <ReasoningBlock text={m.reasoning} />}
                  <Markdown text={m.content} />
                </>
              )}

              <footer className="mt-2 flex items-center gap-2 border-t border-hairline pt-2 font-mono text-[var(--cc-text-caption)] text-muted">
                <span className="flex-1">
                  {m.tokensIn}→{m.tokensOut}
                </span>
                <button aria-label="Скопировать" className="p-1 active:opacity-60" onClick={() => onCopy(m.content)}>
                  <Copy size={13} />
                </button>
                {/* Выбор победителя — не украшение: в контекст следующего
                    вопроса уходит только он, остальные остаются историей. */}
                <button
                  aria-label={m.chosen ? 'Выбран' : 'Выбрать этот ответ'}
                  title="В контекст пойдёт этот ответ"
                  className={`flex items-center gap-1 rounded-[var(--cc-radius-sm)] px-1.5 py-1 transition-colors ${
                    m.chosen ? 'text-accent' : 'hover:text-text'
                  }`}
                  onClick={() => void chooseWinner(m.runId ?? '', m.id)}
                >
                  {m.chosen ? <Check size={13} /> : <Crown size={13} />}
                  {m.chosen ? 'в контексте' : 'выбрать'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
