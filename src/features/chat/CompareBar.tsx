import { Columns2, X } from '../../components/ui/glyphs';
import type { Provider } from '../../db/types';
import { modelIds, modelLabel } from '../../lib/ai/models';
import { useT } from '../../lib/i18n';

interface Props {
  providers: Provider[];
  /** Выбранные модели в виде `providerId:model`. */
  picks: string[];
  /** Что делать с выбранными: колонки бок о бок или консилиум. */
  mode: 'columns' | 'council';
  onChange: (picks: string[]) => void;
  onMode: (mode: 'columns' | 'council') => void;
}

/**
 * Панель режима сравнения над полем ввода. Ровно одна кнопка в свёрнутом
 * состоянии — режим редкий, и постоянно занимать им место в композере нельзя.
 */
export function CompareBar({ providers, picks, mode, onChange, onMode }: Props) {
  const t = useT();
  const all = providers.flatMap((p) => modelIds(p.models).map((m) => ({ key: `${p.id}:${m}`, provider: p, model: m })));
  const active = picks.length > 0;

  if (!active) {
    return (
      <button
        onClick={() => onChange(all.slice(0, Math.min(2, all.length)).map((x) => x.key))}
        title={t('compare.tooltip')}
        className="flex items-center gap-1.5 rounded-[var(--cc-radius-sm)] px-2 py-1 font-mono text-[length:var(--cc-text-caption)] text-muted transition-colors hover:bg-[var(--cc-fill-ghost-hover)] hover:text-text"
      >
        <Columns2 size={13} />
        {t('compare.button')}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[length:var(--cc-text-caption)] text-muted">{t('compare.prefix')}</span>
      {all.map((x) => {
        const on = picks.includes(x.key);
        return (
          <button
            key={x.key}
            data-testid={`compare-chip:${x.key}`}
            onClick={() => onChange(on ? picks.filter((k) => k !== x.key) : [...picks, x.key])}
            className={`rounded-full border px-2.5 py-1 font-mono text-[length:var(--cc-text-caption)] transition-colors ${
              on ? 'border-accent text-accent' : 'border-hairline text-muted hover:text-text'
            }`}
          >
            {modelLabel(x.model)}
          </button>
        );
      })}
      {/* Два взгляда на выбранные модели: колонки (кто что ответил) или
          консилиум (обсуждают и сводят один ответ). Переключатель живёт
          рядом с чипами — это свойство именно этого набора моделей. */}
      <span className="inline-flex rounded-full bg-surface-2 p-0.5">
        {(['columns', 'council'] as const).map((m) => (
          <button
            key={m}
            aria-pressed={mode === m}
            onClick={() => onMode(m)}
            className={`rounded-full px-2 py-0.5 text-[length:var(--cc-text-caption)] font-medium transition-colors ${
              mode === m ? 'bg-accent text-white' : 'text-muted hover:text-text'
            }`}
          >
            {m === 'columns' ? t('council.modeColumns') : t('council.mode')}
          </button>
        ))}
      </span>
      <button
        aria-label={t('compare.offAria')}
        onClick={() => onChange([])}
        className="grid size-6 place-items-center rounded-full text-muted transition-colors hover:text-text"
      >
        <X size={13} />
      </button>
      {picks.length === 1 && (
        <span className="font-mono text-[length:var(--cc-text-caption)] text-warning">{t('compare.needTwo')}</span>
      )}
    </div>
  );
}
