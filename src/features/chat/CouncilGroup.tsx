import { useMemo, useState } from 'react';
import { ChevronDown, Crown } from '../../components/ui/glyphs';
import type { Message } from '../../db/types';
import { formatCost, formatTokens, modelLabel } from '../../lib/ai/models';
import { parseRanking } from '../../lib/ai/council';
import { useT } from '../../lib/i18n';
import { Markdown } from './Markdown';

/**
 * Прогон консилиума в ленте: финал председателя — как обычный ответ, ход
 * обсуждения (мнения → после дебатов → ранжирование) — свёрнутой секцией над
 * ним, по образу мыслей модели. Раскрытый ход — вкладки по участникам внутри
 * каждой стадии не городим: простые блоки с подписью модели, обсуждение
 * читается сверху вниз.
 */
export function CouncilGroup({
  group,
  onCopy,
}: {
  group: Message[];
  onCopy: (text: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const final = group.find((m) => m.councilStage === 'final');
  const opinions = group.filter((m) => m.councilStage === 'opinion');
  const debates = group.filter((m) => m.councilStage === 'debate');
  const reviews = group.filter((m) => m.councilStage === 'review');

  // Сводка ранжирования: суммируем места из JSON-ответов ревьюеров.
  const ranking = useMemo(() => {
    const score = new Map<string, number>();
    for (const r of reviews) {
      for (const row of parseRanking(r.content) ?? []) {
        score.set(row.letter, (score.get(row.letter) ?? 0) + row.rank);
      }
    }
    return [...score.entries()].sort((a, b) => a[1] - b[1]);
  }, [reviews]);

  const totalTokens = group.reduce((n, m) => n + (m.tokensIn ?? 0) + (m.tokensOut ?? 0), 0);
  const totalRub = group.reduce((n, m) => n + (m.costRub ?? 0), 0);

  return (
    <div className="group/council animate-msg-in grid grid-cols-[var(--cc-marker-col)_1fr]">
      <div aria-hidden className="pt-[0.55rem]">
        <span className="block size-1.5 rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mb-1 flex items-center gap-1.5 rounded-[var(--cc-radius-sm)] px-1 py-0.5 text-[length:var(--cc-text-caption)] font-medium text-muted transition-colors hover:text-text"
        >
          <Crown size={13} className="text-accent/80" />
          {t('council.trace', { n: opinions.length })}
          <span className="font-mono font-normal text-muted/60 tabular-nums">
            {formatTokens(totalTokens)} · {totalRub > 0 ? formatCost(totalRub) : formatCost(0)}
          </span>
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="mb-2 space-y-3 rounded-[var(--cc-radius)] border border-hairline p-3">
            <StageBlock title={t('council.opinions')} items={opinions} />
            {debates.length > 0 && <StageBlock title={t('council.debates')} items={debates} />}
            {ranking.length > 0 && (
              <div>
                <p className="mb-1 text-[length:var(--cc-text-caption)] font-medium text-muted">{t('council.ranking')}</p>
                <div className="space-y-0.5">
                  {ranking.map(([letter, score], i) => (
                    <p key={letter} className="flex items-baseline gap-2 text-[length:var(--cc-text-meta)]">
                      <span className="font-mono text-muted tabular-nums">{i + 1}.</span>
                      <span className="min-w-0 flex-1">{t('council.answerLetter', { letter })}</span>
                      <span className="shrink-0 font-mono text-muted tabular-nums">{score}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {final ? (
          <>
            <Markdown text={final.content} />
            <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[length:var(--cc-text-caption)] text-muted opacity-0 transition-opacity duration-150 group-hover/council:opacity-100 max-lg:opacity-100">
              {final.tokensIn != null && (
                <span className="tabular-nums">
                  {formatTokens(final.tokensIn)}→{formatTokens(final.tokensOut ?? 0)}
                  {final.costRub != null && final.costRub >= 0 ? ` · ${final.costRub > 0 ? formatCost(final.costRub) : formatCost(0)}` : ''}
                </span>
              )}
              {final.model && <span className="truncate">{modelLabel(final.model)}</span>}
              <button
                aria-label={t('chat.copy')}
                className="cc-hit rounded-[var(--cc-radius-sm)] p-1 hover:text-text"
                onClick={() => onCopy(final.content)}
              >
                {t('chat.copy')}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">{t('council.noFinal')}</p>
        )}
      </div>
    </div>
  );
}

function StageBlock({ title, items }: { title: string; items: Message[] }) {
  return (
    <div>
      <p className="mb-1 text-[length:var(--cc-text-caption)] font-medium text-muted">{title}</p>
      <div className="space-y-2.5">
        {items.map((m) => (
          <div key={m.id}>
            <p className="mb-0.5 font-mono text-[length:var(--cc-text-caption)] text-muted/70">{modelLabel(m.model ?? '')}</p>
            <div className="text-[length:var(--cc-text-meta)] leading-relaxed">
              <Markdown text={m.content} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
