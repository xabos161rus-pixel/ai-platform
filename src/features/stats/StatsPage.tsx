import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { ChevronLeft } from '../../components/ui/glyphs';
import {
  allSpendByModel,
  monthSpendByChat,
  monthSpendByModel,
  monthSpendRub,
  spendByDay,
  spendMonths,
  todaySpend,
  totalStats,
  type ChatSpend,
  type DaySpend,
  type ModelSpend,
  type MonthSpend,
} from '../../lib/ai/chatRepo';
import { formatCost, formatTokens, modelLabel } from '../../lib/ai/models';
import { useT } from '../../lib/i18n';

/**
 * Страница статистики: вся аналитика расхода в одном месте. В настройках
 * остаётся только контроль (бюджет и потрачено за месяц) — аналитика там
 * тонула в простыне.
 */
export function StatsPage() {
  const t = useT();
  const today = useLiveQuery(() => todaySpend(), [], { rub: 0, tokens: 0 });
  const monthRub = useLiveQuery(() => monthSpendRub(), [], 0);
  const totals = useLiveQuery(() => totalStats(), [], { chats: 0, messages: 0, tokens: 0, rub: 0 });
  const byDay = useLiveQuery(() => spendByDay(30), [], [] as DaySpend[]);
  const byModel = useLiveQuery(() => monthSpendByModel(), [], [] as ModelSpend[]);
  const allByModel = useLiveQuery(() => allSpendByModel(), [], [] as ModelSpend[]);
  const byChat = useLiveQuery(() => monthSpendByChat(8), [], [] as ChatSpend[]);
  const months = useLiveQuery(() => spendMonths(6), [], [] as MonthSpend[]);

  const monthTokens = byModel.reduce((n, r) => n + r.tokens, 0);
  const empty = totals.messages === 0;

  return (
    <div className="fixed inset-0 flex flex-col bg-bg">
      <div aria-hidden className="cc-aurora pointer-events-none fixed inset-0" />
      <header className="relative z-10 flex shrink-0 items-center gap-1 border-b border-hairline px-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-2">
        <Link
          to="/"
          aria-label={t('settings.backAria')}
          className="grid size-[var(--cc-touch)] place-items-center rounded-[var(--cc-radius)] text-accent active:opacity-60"
        >
          <ChevronLeft size={22} />
        </Link>
        <h1 className="flex-1 text-[0.95rem] font-semibold">{t('stats.title')}</h1>
      </header>

      <div className="cc-scroll relative z-10 mx-auto w-full max-w-3xl flex-1 space-y-8 overflow-y-auto px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {empty ? (
          <p className="py-16 text-center text-sm text-muted">{t('stats.empty')}</p>
        ) : (
          <>
            {/* Сводка: три тихие колонки, цифры моно — это машинный слой. */}
            <section className="grid grid-cols-3 gap-3">
              {(
                [
                  { label: t('stats.today'), rub: today.rub, sub: t('stats.tokens', { n: formatTokens(today.tokens) }) },
                  { label: t('stats.month'), rub: monthRub, sub: t('stats.tokens', { n: formatTokens(monthTokens) }) },
                  { label: t('stats.total'), rub: totals.rub, sub: t('stats.tokens', { n: formatTokens(totals.tokens) }) },
                ] as const
              ).map((card) => (
                <div key={card.label} className="rounded-[var(--cc-radius)] border border-hairline px-3.5 py-3">
                  <p className="text-[length:var(--cc-text-caption)] font-medium text-muted">{card.label}</p>
                  <p className="mt-1 font-mono text-lg tabular-nums">{card.rub > 0 ? formatCost(card.rub) : '0 ₽'}</p>
                  <p className="font-mono text-[length:var(--cc-text-caption)] text-muted tabular-nums">{card.sub}</p>
                </div>
              ))}
            </section>
            <p className="-mt-6 text-[length:var(--cc-text-caption)] text-muted">
              {t('stats.chats', { n: totals.chats })} · {t('stats.messages', { n: totals.messages })}
            </p>

            {allByModel.length > 0 && (
              <Section title={t('stats.byModelAll')}>
                {(() => {
                  const totalRub = allByModel.reduce((n, r) => n + r.rub, 0);
                  const totalTok = allByModel.reduce((n, r) => n + r.tokens, 0);
                  return (
                    <div className="space-y-2">
                      {allByModel.map((r) => {
                        // Доля от общего расхода; на бесплатных моделях (₽=0)
                        // долю ведут токены — картина всё равно честная.
                        const share = totalRub > 0 ? r.rub / totalRub : totalTok > 0 ? r.tokens / totalTok : 0;
                        return (
                          <div key={r.model}>
                            <p className="flex items-baseline justify-between gap-3 text-[length:var(--cc-text-meta)]">
                              <span className="min-w-0 truncate">{modelLabel(r.model)}</span>
                              <span className="shrink-0 font-mono tabular-nums">
                                {formatTokens(r.tokens)} · {r.rub > 0 ? formatCost(r.rub) : '0 ₽'}
                              </span>
                            </p>
                            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </Section>
            )}

            <Section title={t('settings.spendByDay')}>
              {(() => {
                const max = Math.max(1, ...byDay.map((d) => d.rub));
                const maxTokens = Math.max(1, ...byDay.map((d) => d.tokens));
                const useTokens = byDay.every((d) => d.rub === 0);
                return (
                  <div className="flex h-16 items-end gap-[2px]">
                    {byDay.map((d) => {
                      const v = useTokens ? d.tokens / maxTokens : d.rub / max;
                      const has = useTokens ? d.tokens > 0 : d.rub > 0;
                      return (
                        <div
                          key={d.day}
                          title={`${d.day} · ${d.rub > 0 ? formatCost(d.rub) : formatTokens(d.tokens)}`}
                          className={`min-w-0 flex-1 rounded-t-[2px] ${has ? 'bg-accent' : 'bg-surface-2'}`}
                          style={{ height: has ? `${Math.max(8, v * 100)}%` : '3px' }}
                        />
                      );
                    })}
                  </div>
                );
              })()}
            </Section>

            {byModel.length > 0 && (
              <Section title={t('stats.byModel')}>
                <Rows rows={byModel.map((r) => ({ key: r.model, label: modelLabel(r.model), tokens: r.tokens, rub: r.rub }))} />
              </Section>
            )}

            {byChat.length > 0 && (
              <Section title={t('settings.spendByChat')}>
                <Rows rows={byChat.map((r) => ({ key: r.chatId, label: r.title || t('chat.newChat'), tokens: r.tokens, rub: r.rub }))} />
              </Section>
            )}

            {months.length > 1 && (
              <Section title={t('settings.spendMonths')}>
                <Rows rows={months.map((r) => ({ key: r.month, label: r.month, tokens: r.tokens, rub: r.rub }))} />
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: { key: string; label: string; tokens: number; rub: number }[] }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <p key={r.key} className="flex items-baseline justify-between gap-3 text-[length:var(--cc-text-meta)]">
          <span className="min-w-0 truncate text-muted">{r.label}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {formatTokens(r.tokens)} · {r.rub > 0 ? formatCost(r.rub) : '0 ₽'}
          </span>
        </p>
      ))}
    </div>
  );
}

export default StatsPage;
